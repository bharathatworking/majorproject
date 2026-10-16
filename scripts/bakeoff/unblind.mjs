/**
 * npm run bakeoff:unblind — joins the labelled blind sheet with its key and
 * writes eval/model-bakeoff/REPORT.md. Run only after labelling is done.
 *
 *   node scripts/bakeoff/unblind.mjs [--allow-missing]
 *
 * Design decisions:
 *  - The analysis is fixed before the labels exist (committed with the
 *    export), so nothing in it can be tuned to the result. Thresholds come
 *    from lib.ts constants and are printed in the report.
 *  - Meaning kept = faithful / labelled over outputs that are not near
 *    copies (a near copy keeps meaning trivially), with a Wilson 95% CI;
 *    near copies are reported separately. 'unsure' rows are left out and
 *    counted. Every row must be labelled unless --allow-missing.
 *  - FKGL drop and target-grade hit use the plain text (toPlainText), as
 *    the app's metrics do. Empty outputs count as target misses and are
 *    left out of the FKGL mean.
 *  - Paired comparison: exact McNemar on the paragraphs where both models'
 *    outputs are labelled and neither is a near copy.
 *  - The winner comes from pickWinner (lib.ts) exactly as pre-registered.
 *    Fine-tunability (Unsloth on a Colab T4) and the licence come from
 *    models.json, which records the evidence links.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { readJsonl } from '../lib/nli-node.mjs';
import { CSV, KEY, MODELS_INFO, OUTPUTS, REPORT, openApp } from './app.mjs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const pct = (x, d = 1) => (x === null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : x.toFixed(d));
const gib = bytes => (bytes ? `${(bytes / 2 ** 30).toFixed(2)} GiB` : 'n/a');
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const FLAG_NAMES = ['empty', 'refusal', 'nonEnglish', 'listLost', 'nearCopy', 'lengthOutOfRange'];

// ─── Main ─────────────────────────────────────────────────────────────────────

const app = await openApp();
try {
  const lib = app.lib;
  for (const f of [CSV, KEY, OUTPUTS, MODELS_INFO]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const key = JSON.parse(await readFile(KEY, 'utf8'));
  const labels = lib.unblind(await readFile(CSV, 'utf8'), key);
  const unlabelled = Object.keys(key.rows).length - labels.filter(l => l.label !== null).length;
  if (unlabelled > 0 && !process.argv.includes('--allow-missing')) {
    throw new Error(`${unlabelled} rows have no label; finish labelling or pass --allow-missing`);
  }
  const info = JSON.parse(await readFile(MODELS_INFO, 'utf8'));
  const outputs = await readJsonl(OUTPUTS);
  const labelOf = new Map(labels.map(l => [`${l.model}|${l.paragraphId}`, l.label]));

  // ── Per model
  const rows = lib.BAKEOFF_MODELS.map(model => {
    const gpu = outputs.filter(o => o.model === model && o.mode === 'gpu');
    const cpu = outputs.filter(o => o.model === model && o.mode === 'cpu');
    const withLabel = gpu.map(o => ({ ...o, label: labelOf.get(`${model}|${o.paragraphId}`) ?? null }));
    const counted = withLabel.filter(o => !o.flags.nearCopy && (o.label === 'faithful' || o.label === 'unfaithful'));
    const kept = counted.filter(o => o.label === 'faithful').length;
    const nonEmpty = gpu.filter(o => !o.flags.empty && o.fkglAfter !== null);
    const nearCopies = gpu.filter(o => o.flags.nearCopy).length;
    const m = info[model] ?? {};
    return {
      model,
      outputs: gpu.length,
      counted: counted.length,
      kept,
      meaningKept: counted.length ? kept / counted.length : null,
      ci: lib.wilson(kept, counted.length),
      nearCopies,
      nearCopyShare: gpu.length ? nearCopies / gpu.length : 0,
      unsure: withLabel.filter(o => o.label === 'unsure').length,
      unlabelled: withLabel.filter(o => o.label === null).length,
      fkglDrop: mean(nonEmpty.map(o => o.fkglBefore - o.fkglAfter)),
      fkglAfter: mean(nonEmpty.map(o => o.fkglAfter)),
      targetHit: gpu.length ? nonEmpty.filter(o => Math.abs(o.fkglAfter - o.targetGrade) <= lib.TARGET_HIT_TOLERANCE).length / gpu.length : null,
      flags: Object.fromEntries(FLAG_NAMES.map(f => [f, gpu.filter(o => o.flags[f]).length])),
      gpuMedian: lib.percentile(gpu.map(o => o.secPer100), 50),
      gpuP90: lib.percentile(gpu.map(o => o.secPer100), 90),
      cpuMedian: lib.percentile(cpu.map(o => o.secPer100), 50),
      cpuP90: lib.percentile(cpu.map(o => o.secPer100), 90),
      cpuCount: cpu.length,
      gpuMemory: gpu[0]?.memory ?? null,
      cpuMemory: cpu[0]?.memory ?? null,
      diskSize: gpu[0]?.diskSize ?? null,
      temperature: gpu[0]?.defaultTemperature ?? null,
      think: gpu.filter(o => o.hadThink).length,
      thinkSent: gpu[0]?.think,
      licence: m.licence ?? 'n/a',
      licenceUrl: m.licenceUrl ?? null,
      finetunable: m.finetunable === true,
      evidence: m.unslothEvidence ?? [],
      note: m.note ?? '',
    };
  });

  // ── Paired comparison (McNemar exact)
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const [a, b] = [rows[i].model, rows[j].model];
      const ids = [...new Set(outputs.filter(o => o.mode === 'gpu').map(o => o.paragraphId))];
      let both = 0; let onlyA = 0; let onlyB = 0; let neither = 0;
      for (const id of ids) {
        const oa = outputs.find(o => o.model === a && o.mode === 'gpu' && o.paragraphId === id);
        const ob = outputs.find(o => o.model === b && o.mode === 'gpu' && o.paragraphId === id);
        const la = labelOf.get(`${a}|${id}`);
        const lb = labelOf.get(`${b}|${id}`);
        if (!oa || !ob || oa.flags.nearCopy || ob.flags.nearCopy) continue;
        if (!['faithful', 'unfaithful'].includes(la) || !['faithful', 'unfaithful'].includes(lb)) continue;
        if (la === 'faithful' && lb === 'faithful') both++;
        else if (la === 'faithful') onlyA++;
        else if (lb === 'faithful') onlyB++;
        else neither++;
      }
      pairs.push({ a, b, n: both + onlyA + onlyB + neither, both, onlyA, onlyB, neither, p: lib.mcnemarExact(onlyA, onlyB) });
    }
  }

  // ── Winner
  const result = lib.pickWinner(rows.map(r => ({
    model: r.model, meaningKept: r.meaningKept, fkglDrop: r.fkglDrop, nearCopyShare: r.nearCopyShare,
    cpuMedian: r.cpuMedian, finetunable: r.finetunable,
  })));

  // ── REPORT.md
  const first = outputs.find(o => o.mode === 'gpu') ?? {};
  const lines = [
    '# Base-model bake-off report (Prompt 9.4)',
    '',
    `Generated by \`npm run bakeoff:unblind\` on ${new Date().toISOString().slice(0, 10)} from the blind labels in \`labels_bakeoff.csv\`. ` +
    `Ollama ${first.ollamaVersion ?? 'n/a'}; Student preset, target grade ${first.targetGrade ?? 'n/a'}; seed ${lib.GENERATION_SEED}; ` +
    'each model at its own default sampling (the app sends no temperature); one first-try output per pair.',
    '',
    `**Result:** ${result.winner ? `**${result.winner}** wins under the pre-registered rule.` : 'no model wins under the pre-registered rule.'} ` +
    'The app\'s default model is unchanged.',
    '',
    '## Per model',
    '',
    '| | ' + rows.map(r => `\`${r.model}\``).join(' | ') + ' |',
    '|---|' + rows.map(() => '---|').join(''),
    '| Meaning kept (not near copies) | ' + rows.map(r => `${pct(r.meaningKept)} (${r.kept}/${r.counted}) [${r.ci ? `${pct(r.ci[0], 0)}–${pct(r.ci[1], 0)}` : 'n/a'}]`).join(' | ') + ' |',
    '| Near copies | ' + rows.map(r => `${r.nearCopies}/${r.outputs} (${pct(r.nearCopyShare, 0)})`).join(' | ') + ' |',
    '| Unsure / unlabelled | ' + rows.map(r => `${r.unsure} / ${r.unlabelled}`).join(' | ') + ' |',
    '| Mean FKGL drop | ' + rows.map(r => num(r.fkglDrop)).join(' | ') + ' |',
    '| Mean FKGL after | ' + rows.map(r => num(r.fkglAfter)).join(' | ') + ' |',
    `| Target-grade hit (±${lib.TARGET_HIT_TOLERANCE}) | ` + rows.map(r => pct(r.targetHit)).join(' | ') + ' |',
    ...FLAG_NAMES.map(f => `| Flag: ${f} | ` + rows.map(r => String(r.flags[f])).join(' | ') + ' |'),
    '| Outputs with a think block | ' + rows.map(r => `${r.think} (think: ${r.thinkSent === false ? 'false sent' : 'not sent'})`).join(' | ') + ' |',
    '| GPU s/100 words, median / p90 | ' + rows.map(r => `${num(r.gpuMedian)} / ${num(r.gpuP90)}`).join(' | ') + ' |',
    '| CPU-only s/100 words, median / p90 | ' + rows.map(r => `${num(r.cpuMedian)} / ${num(r.cpuP90)} (n = ${r.cpuCount})`).join(' | ') + ' |',
    '| Size loaded on GPU (/api/ps, VRAM) | ' + rows.map(r => r.gpuMemory ? `${gib(r.gpuMemory.size)} (${gib(r.gpuMemory.sizeVram)} VRAM)` : 'n/a').join(' | ') + ' |',
    '| Size loaded CPU-only (/api/ps) | ' + rows.map(r => r.cpuMemory ? gib(r.cpuMemory.size) : 'n/a').join(' | ') + ' |',
    '| File size (/api/tags) | ' + rows.map(r => gib(r.diskSize)).join(' | ') + ' |',
    '| Default temperature | ' + rows.map(r => (r.temperature === null ? 'Ollama default' : String(r.temperature))).join(' | ') + ' |',
    '| Licence | ' + rows.map(r => (r.licenceUrl ? `[${r.licence}](${r.licenceUrl})` : r.licence)).join(' | ') + ' |',
    '| Unsloth on a Colab T4 | ' + rows.map(r => `${r.finetunable ? 'yes' : 'no'}${r.evidence.length ? ': ' + r.evidence.map(e => `[${e.label}](${e.url})`).join(', ') : ''}`).join(' | ') + ' |',
    '',
    `Meaning kept counts only outputs that are not near copies (word edit ratio < ${lib.NEAR_COPY_EDIT_RATIO * 100}% or similarity > ${lib.NEAR_COPY_SIMILARITY}). ` +
    `Target-grade hit is the share of all ${rows[0].outputs} outputs whose FKGL is within ${lib.TARGET_HIT_TOLERANCE} of the target (empty outputs miss). ` +
    `Flags are over the ${rows[0].outputs} GPU outputs; length is out of range below ${lib.LENGTH_RATIO_MIN} or above ${lib.LENGTH_RATIO_MAX} of the original's words.`,
    ...rows.filter(r => r.note).map(r => `\n- \`${r.model}\`: ${r.note}`),
    '',
    '## Paired comparison (exact McNemar)',
    '',
    'Over paragraphs where both outputs are labelled and neither is a near copy. b = only the first model kept meaning; c = only the second. Three comparisons, so the Bonferroni level is α = 0.05 / 3 ≈ 0.0167.',
    '',
    '| Models | n | Both kept | b | c | Neither | p |',
    '|---|---|---|---|---|---|---|',
    ...pairs.map(p => `| \`${p.a}\` vs \`${p.b}\` | ${p.n} | ${p.both} | ${p.onlyA} | ${p.onlyB} | ${p.neither} | ${p.p < 0.001 ? '< 0.001' : p.p.toFixed(3)} |`),
    '',
    '## Winner (pre-registered rule)',
    '',
    `1. Eligible: mean FKGL drop ≥ ${lib.MIN_FKGL_DROP} grades and near copies ≤ ${pct(lib.MAX_NEAR_COPY_SHARE, 0)} of outputs.`,
    '2. Among eligible models, the highest meaning kept wins.',
    `3. If the top two are within ${pct(lib.TIE_MARGIN, 0)} points, the faster CPU-only model (median s/100 words) wins.`,
    '4. The winner must be fine-tunable with Unsloth on a Colab T4; otherwise it is dropped and the rule is applied again.',
    '',
    ...result.steps.map(s => `- ${s}`),
    '',
    `**Winner: ${result.winner ?? 'none'}.**`,
    '',
  ];
  await writeFile(REPORT, lines.join('\n'));
  console.log(`[Clarity] ${labels.length} labels unblinded; report written to ${REPORT}; winner: ${result.winner ?? 'none'}`);
} catch (err) {
  console.error(`[Clarity] ${err.message}`);
  process.exitCode = 1;
} finally {
  await app.close();
}
