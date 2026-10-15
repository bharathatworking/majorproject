/**
 * fp16 experiment (debug only): does the NLI model run faster on WebGPU with
 * fp16 weights than with the default q8 weights, and does it make the same
 * decisions?
 *
 * Design decisions:
 *  - Installed only when debug:nliDevice = 'webgpu-fp16' (main.tsx loads this
 *    module dynamically), as `clarityNliExperiment()` in the app tab's
 *    DevTools console. It never changes the default (q8) and is never
 *    loaded in a normal session.
 *  - Data: the committed calibration set (eval/nli-calibration/, imported
 *    ?raw into this lazy chunk only). Timing uses the 15 real qwen2.5:3b
 *    paragraph simplifications (paragraphs.jsonl), each checked whole like
 *    a run does; decision agreement uses those paragraphs and the 60
 *    sentence items (pairs.jsonl).
 *  - Same code as a run: checkEntailment with the app's premises, ranking
 *    and paragraph rule. Two fresh clients, each with its own worker:
 *    'auto' (WebGPU q8) and 'webgpu-fp16'. Premise embeddings are memoized
 *    and computed before timing, so both dtypes get identical premises and
 *    the timed part is the NLI scoring (scoreMs) plus ranking from memory.
 *  - Each client is loaded and warmed up (the speed benchmark pairs) before
 *    it is timed, and runs alone, one after the other.
 *  - Output: a console summary and a downloaded JSON
 *    (clarity-nli-experiment-<date>.json): ms per paragraph for each dtype,
 *    paragraph and sentence decision agreement, false-fail and catch rate
 *    against the labels, and the largest probability differences.
 */

import pairsRaw from '../../../eval/nli-calibration/pairs.jsonl?raw';
import paragraphsRaw from '../../../eval/nli-calibration/paragraphs.jsonl?raw';
import { OllamaProvider } from '../llm/ollama-provider';
import { checkEntailment, createNliClient, NLI_BENCH_PAIRS, type NliClient } from './nli';
import type { EntailmentCheck, NliDevice } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CalibrationItem {
  id: string;
  paragraphId: string;
  hypothesis: string;
  proposedLabel: 'faithful' | 'wrong';
  label?: 'faithful' | 'wrong';
}

interface CalibrationParagraph {
  id: string;
  text: string;
  simplification?: string;
}

/** One dtype's results. */
interface DtypeRun {
  device: NliDevice;
  backend: string;
  dtype: string;
  adapterVendor: string | null;
  loadMs: number;
  webgpuError?: string;
  /** Per paragraph: NLI ms (rank from memory + scoring) and scoring ms. */
  paragraphMs: number[];
  paragraphScoreMs: number[];
  paragraphPassed: Record<string, boolean>;
  sentence: Record<string, { passed: boolean; entailment: number; contradiction: number }>;
}

export interface NliExperimentReport {
  format: 'clarity-nli-experiment/1';
  at: string;
  runs: { q8: Summary; fp16: Summary };
  agreement: {
    paragraphs: { agree: number; total: number; rate: number };
    sentences: { agree: number; total: number; rate: number };
  };
  /** Rates against the calibration labels (label, else proposedLabel). */
  accuracy: { q8: Accuracy; fp16: Accuracy };
  largestDifferences: {
    id: string; hypothesis: string;
    q8: { entailment: number; contradiction: number };
    fp16: { entailment: number; contradiction: number };
  }[];
}

interface Summary {
  backend: string;
  dtype: string;
  adapterVendor: string | null;
  loadMs: number;
  webgpuError?: string;
  paragraphs: number;
  meanParagraphMs: number;
  medianParagraphMs: number;
  meanParagraphScoreMs: number;
}

interface Accuracy {
  falseFail: number;
  catchRate: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parseJsonl = <T>(raw: string): T[] =>
  raw.split(/\r?\n/).filter(l => l.trim() !== '').map(l => JSON.parse(l) as T);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Embeds texts through Ollama all-minilm once each; null without the model. */
function memoEmbed(): (texts: string[]) => Promise<number[][]> {
  const provider = new OllamaProvider();
  const memo = new Map<string, number[]>();
  return async (texts) => {
    const missing = [...new Set(texts.filter(t => !memo.has(t)))];
    if (missing.length > 0) {
      const vectors = await provider.embed(missing);
      missing.forEach((t, i) => memo.set(t, vectors[i]));
    }
    return texts.map(t => memo.get(t) as number[]);
  };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function runDtype(
  device: NliDevice,
  client: NliClient,
  paragraphs: CalibrationParagraph[],
  items: CalibrationItem[],
  byId: Map<string, CalibrationParagraph>,
  embed: ((texts: string[]) => Promise<number[][]>) | undefined,
): Promise<DtypeRun> {
  const info = await client.load();
  await client.bench([...NLI_BENCH_PAIRS]);  // warm-up: shaders compiled, caches filled

  const run: DtypeRun = {
    device,
    backend: info.backend,
    dtype: info.dtype ?? 'q8',
    adapterVendor: info.adapter?.vendor || null,
    loadMs: Math.round(info.loadMs),
    ...(info.webgpuError !== undefined && { webgpuError: info.webgpuError }),
    paragraphMs: [],
    paragraphScoreMs: [],
    paragraphPassed: {},
    sentence: {},
  };

  for (const p of paragraphs) {
    const r: EntailmentCheck = await checkEntailment(p.text, p.simplification as string, [], client, { label: p.id, embed });
    run.paragraphMs.push(r.ms);
    run.paragraphScoreMs.push(r.scoreMs);
    run.paragraphPassed[p.id] = r.passed;
  }
  for (const item of items) {
    const original = byId.get(item.paragraphId)?.text ?? '';
    const r = await checkEntailment(original, item.hypothesis, [], client, { label: item.id, embed });
    const s = r.sentenceScores[0];
    run.sentence[item.id] = { passed: r.passed, entailment: s?.entailment ?? 0, contradiction: s?.contradiction ?? 0 };
  }
  return run;
}

function summarize(run: DtypeRun): Summary {
  return {
    backend: run.backend,
    dtype: run.dtype,
    adapterVendor: run.adapterVendor,
    loadMs: run.loadMs,
    ...(run.webgpuError !== undefined && { webgpuError: run.webgpuError }),
    paragraphs: run.paragraphMs.length,
    meanParagraphMs: round(mean(run.paragraphMs)),
    medianParagraphMs: round(median(run.paragraphMs)),
    meanParagraphScoreMs: round(mean(run.paragraphScoreMs)),
  };
}

function accuracy(run: DtypeRun, items: CalibrationItem[]): Accuracy {
  const label = (i: CalibrationItem) => i.label ?? i.proposedLabel;
  const faithful = items.filter(i => label(i) === 'faithful');
  const wrong = items.filter(i => label(i) === 'wrong');
  return {
    falseFail: round(faithful.filter(i => !run.sentence[i.id].passed).length / Math.max(1, faithful.length), 4),
    catchRate: round(wrong.filter(i => !run.sentence[i.id].passed).length / Math.max(1, wrong.length), 4),
  };
}

/** Runs the experiment, logs a summary and downloads the JSON report. */
export async function runNliExperiment(): Promise<NliExperimentReport> {
  const items = parseJsonl<CalibrationItem>(pairsRaw);
  const all = parseJsonl<CalibrationParagraph>(paragraphsRaw);
  const byId = new Map(all.map(p => [p.id, p]));
  const paragraphs = all.filter(p => p.simplification);

  let embed: ((texts: string[]) => Promise<number[][]>) | undefined = memoEmbed();
  try {
    // Every premise and hypothesis, embedded before anything is timed
    await embed(['probe']);
  } catch {
    console.info('[Clarity] NLI experiment: all-minilm not reachable, premises ranked by word overlap');
    embed = undefined;
  }

  console.log(`[Clarity] NLI experiment: ${paragraphs.length} paragraphs, ${items.length} sentence items; q8 first`);
  const q8 = await runDtype('auto', createNliClient(async () => 'auto'), paragraphs, items, byId, embed);
  console.log('[Clarity] NLI experiment: q8 done; now fp16');
  const fp16 = await runDtype('webgpu-fp16', createNliClient(async () => 'webgpu-fp16'), paragraphs, items, byId, embed);

  const paragraphAgree = paragraphs.filter(p => q8.paragraphPassed[p.id] === fp16.paragraphPassed[p.id]).length;
  const sentenceAgree = items.filter(i => q8.sentence[i.id].passed === fp16.sentence[i.id].passed).length;
  const largestDifferences = items
    .map(i => ({
      id: i.id,
      hypothesis: i.hypothesis,
      q8: { entailment: round(q8.sentence[i.id].entailment, 4), contradiction: round(q8.sentence[i.id].contradiction, 4) },
      fp16: { entailment: round(fp16.sentence[i.id].entailment, 4), contradiction: round(fp16.sentence[i.id].contradiction, 4) },
      diff: Math.max(
        Math.abs(q8.sentence[i.id].entailment - fp16.sentence[i.id].entailment),
        Math.abs(q8.sentence[i.id].contradiction - fp16.sentence[i.id].contradiction),
      ),
    }))
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 5)
    .map(({ diff: _diff, ...rest }) => rest);

  const report: NliExperimentReport = {
    format: 'clarity-nli-experiment/1',
    at: new Date().toISOString(),
    runs: { q8: summarize(q8), fp16: summarize(fp16) },
    agreement: {
      paragraphs: { agree: paragraphAgree, total: paragraphs.length, rate: round(paragraphAgree / Math.max(1, paragraphs.length), 4) },
      sentences: { agree: sentenceAgree, total: items.length, rate: round(sentenceAgree / Math.max(1, items.length), 4) },
    },
    accuracy: { q8: accuracy(q8, items), fp16: accuracy(fp16, items) },
    largestDifferences,
  };

  const { runs, agreement } = report;
  console.log(
    `[Clarity] NLI experiment: q8 ${runs.q8.backend} ${runs.q8.meanParagraphMs} ms/paragraph ` +
    `(score ${runs.q8.meanParagraphScoreMs}), fp16 ${runs.fp16.backend}/${runs.fp16.dtype} ` +
    `${runs.fp16.meanParagraphMs} ms/paragraph (score ${runs.fp16.meanParagraphScoreMs}); ` +
    `agreement paragraphs ${agreement.paragraphs.agree}/${agreement.paragraphs.total}, ` +
    `sentences ${agreement.sentences.agree}/${agreement.sentences.total}`,
  );
  if (runs.fp16.dtype !== 'fp16') {
    console.info(`[Clarity] NLI experiment: fp16 did not load on WebGPU (${runs.fp16.webgpuError ?? 'unknown reason'})`);
  }

  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `clarity-nli-experiment-${report.at.slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return report;
}

/** Exposes clarityNliExperiment() in the app tab's DevTools console. */
export function installNliExperiment(): void {
  (window as unknown as { clarityNliExperiment?: () => Promise<NliExperimentReport> }).clarityNliExperiment =
    runNliExperiment;
  console.info('[Clarity] fp16 NLI experiment ready: run clarityNliExperiment() in this console');
}
