"""
Prompt 10 Part C: scores the base model and clarity-simplify on the
pre-registered ASSET validation items and writes training/eval/results.json
and training/eval/REPORT.md, including the PREREG.md verdict.

  python training/evaluate.py [--generations training/out/eval_generations.jsonl]
  python training/evaluate.py --self-test

Design decisions:
 - The analysis is fixed by training/eval/PREREG.md; this file implements
   it and nothing else. It refuses to run on incomplete generations.
 - SARI: Hugging Face `evaluate` "sari" (the EASSE-derived implementation),
   pinned to a Hub revision. Scored per item against all 10 ASSET
   references; a pseudo-paragraph's k-th reference is the k-th references of
   its rows joined with a space. HF's corpus SARI is the mean of the item
   scores, so the per-item scores bootstrap directly.
 - BERTScore F1 of output vs SOURCE (meaning kept), roberta-large,
   rescale_with_baseline=True (bert-score 0.3.13).
 - grade hit, near copy, entities kept and seconds per 100 words come from
   generate.mjs (the app's own code).
 - Paired bootstrap: the fine-tuned minus base difference of means over the
   same (item, target) pairs, 10,000 resamples, numpy default_rng(42), 95%
   percentile interval. Entities kept uses only items whose source has an
   entity (the same set for both models).
 - Only ASSET validation is read; ASSET test and TurkCorpus are reserved.
"""

import argparse
import json
import random
import sys
from datetime import date
from pathlib import Path

import numpy as np

# ─── Config ───────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'training' / 'data'
EVAL = ROOT / 'training' / 'eval'
BASE = 'qwen3:4b-instruct-2507-q4_K_M'
TUNED = 'clarity-simplify'
TARGETS = (6, 8)
SARI_REVISION = '1f05a19b3a4266ddaeb58fa506e1314d565f0c8e'  # evaluate-metric/sari, 2026-10-06
BERTSCORE_MODEL = 'roberta-large'
BOOTSTRAP = 10000
SEED = 42

# Pre-registered decision rule (training/eval/PREREG.md), pooled over both targets
MIN_GRADE_HIT_GAIN = 15.0      # points
MAX_SARI_DROP = 1.0            # SARI points
MAX_ENTITY_DROP = 2.0          # points
MAX_TUNED_NEAR_COPY = 5.0      # percent

METRICS = [
    # key, label, scale (x100 for rates), higher is better
    ('grade_hit', 'Grade hit (|FKGL − target| ≤ 1)', 100, True),
    ('sari', 'SARI (10 references)', 1, True),
    ('bertscore', 'BERTScore F1 vs source (rescaled)', 1, True),
    ('entity_recall', 'Entities kept', 100, True),
    ('near_copy', 'Near copies', 100, False),
    ('fkgl', 'Output FKGL', 1, None),
    ('abs_gap', '|FKGL − target|', 1, False),
    ('sec_per_100', 's per 100 words (GPU)', 1, False),
]

# ─── Helpers ──────────────────────────────────────────────────────────────────


def read_jsonl(path):
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def join_references(rows_refs):
    """The k-th reference of a pseudo-paragraph: the k-th reference of each row, joined."""
    count = min(len(r) for r in rows_refs)
    return [' '.join(r[k].strip() for r in rows_refs) for k in range(count)]


def paired_bootstrap(tuned, base, resamples=BOOTSTRAP, seed=SEED):
    """Mean difference (tuned − base) and its 95% percentile interval over paired items."""
    tuned, base = np.asarray(tuned, dtype=float), np.asarray(base, dtype=float)
    diff = tuned - base
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(diff), size=(resamples, len(diff)))
    means = diff[idx].mean(axis=1)
    return float(diff.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def verdict(pooled):
    """The PREREG rule on pooled point estimates; returns (passed, checks)."""
    checks = [
        ('Grade hit rises by ≥ 15 points', pooled['grade_hit']['diff'] * 100 >= MIN_GRADE_HIT_GAIN,
         f"{pooled['grade_hit']['diff'] * 100:+.1f} points"),
        ('SARI drops by ≤ 1.0', pooled['sari']['diff'] >= -MAX_SARI_DROP, f"{pooled['sari']['diff']:+.2f}"),
        ('Entities kept drops by ≤ 2 points', pooled['entity_recall']['diff'] * 100 >= -MAX_ENTITY_DROP,
         f"{pooled['entity_recall']['diff'] * 100:+.1f} points"),
        ('Fine-tuned near-copy rate ≤ 5%', pooled['near_copy']['tuned'] * 100 <= MAX_TUNED_NEAR_COPY,
         f"{pooled['near_copy']['tuned'] * 100:.1f}%"),
    ]
    return all(ok for _, ok, _ in checks), checks

# ─── Self-test ────────────────────────────────────────────────────────────────


def self_test():
    assert join_references([['a1', 'a2'], ['b1', 'b2']]) == ['a1 b1', 'a2 b2']
    assert join_references([['a1', 'a2', 'a3'], ['b1', 'b2']]) == ['a1 b1', 'a2 b2']
    d, lo, hi = paired_bootstrap([1, 1, 1, 1], [0, 0, 0, 0])
    assert (d, lo, hi) == (1.0, 1.0, 1.0)
    d, lo, hi = paired_bootstrap([0.5, 0.7, 0.2, 0.9, 0.4], [0.4, 0.6, 0.3, 0.6, 0.4])
    assert lo <= d <= hi and abs(d - 0.08) < 1e-9
    assert paired_bootstrap([1, 0, 1], [0, 0, 1]) == paired_bootstrap([1, 0, 1], [0, 0, 1])
    pooled = {'grade_hit': {'diff': 0.15}, 'sari': {'diff': -1.0}, 'entity_recall': {'diff': -0.02},
              'near_copy': {'tuned': 0.05}}
    assert verdict(pooled)[0] is True
    pooled['grade_hit']['diff'] = 0.149
    assert verdict(pooled)[0] is False
    print('[Clarity] evaluate.py self-test: all checks pass')
    sys.exit(0)

# ─── Scoring ──────────────────────────────────────────────────────────────────


def load_pairs(generations_path):
    items = json.loads((EVAL / 'items.json').read_text(encoding='utf-8'))
    asset = read_jsonl(DATA / 'asset_val.jsonl')
    assert len(asset) == 2000, 'asset_val.jsonl is not ASSET validation'
    item_list = [('sent', [r]) for r in items['sentences']] + [('para', rows) for rows in items['paragraphs']]
    meta = {}
    for kind, rows in item_list:
        item_id = f's-{rows[0]}' if kind == 'sent' else f'p-{rows[0]}-{rows[-1]}'
        meta[item_id] = {
            'kind': kind, 'rows': rows,
            'source': ' '.join(asset[r]['original'].strip() for r in rows),
            'references': join_references([asset[r]['references'] for r in rows]),
        }
    records = {(r['model'], r['itemId'], r['target']): r for r in read_jsonl(generations_path)}
    missing = [(m, i, t) for m in (BASE, TUNED) for i in meta for t in TARGETS if (m, i, t) not in records]
    if missing:
        sys.exit(f'[Clarity] {len(missing)} generations missing (first {missing[0]}); finish npm run train:eval:gen')
    unflagged = [k for k, r in records.items() if r.get('similarity') is None and r['output'].strip()]
    if unflagged:
        sys.exit(f'[Clarity] {len(unflagged)} outputs have no similarity yet; run generate.mjs --flags-only with Ollama all-minilm')
    pairs = []
    for item_id, m in meta.items():
        for t in TARGETS:
            pairs.append({'itemId': item_id, 'target': t, **m,
                          'base': records[(BASE, item_id, t)], 'tuned': records[(TUNED, item_id, t)]})
    return items, pairs


def score_sari(pairs):
    import evaluate
    sari = evaluate.load('sari', revision=SARI_REVISION)
    for p in pairs:
        for side in ('base', 'tuned'):
            p[side]['sari'] = sari.compute(sources=[p['source']], predictions=[p[side]['output']],
                                           references=[p['references']])['sari']


def score_bertscore(pairs):
    from bert_score import score
    for side in ('base', 'tuned'):
        cands = [p[side]['output'] for p in pairs]
        refs = [p['source'] for p in pairs]
        _, _, f1 = score(cands, refs, model_type=BERTSCORE_MODEL, lang='en', rescale_with_baseline=True,
                         batch_size=16, verbose=False)
        for p, v in zip(pairs, f1.tolist()):
            p[side]['bertscore'] = v


def value(record, key, target):
    if key == 'grade_hit':
        return 1.0 if record['gradeHit'] else 0.0
    if key == 'near_copy':
        return 1.0 if record['nearCopy'] else 0.0
    if key == 'entity_recall':
        return record['entityRecall']
    if key == 'fkgl':
        return record['fkglAfter']
    if key == 'abs_gap':
        return None if record['fkglAfter'] is None else abs(record['fkglAfter'] - target)
    if key == 'sec_per_100':
        return record['secPer100']
    return record[key]


def summarise(pairs):
    out = {}
    for key, _, _, _ in METRICS:
        tuned, base = [], []
        for p in pairs:
            a, b = value(p['tuned'], key, p['target']), value(p['base'], key, p['target'])
            if a is None or b is None:
                continue
            tuned.append(a)
            base.append(b)
        if not tuned:
            out[key] = None
            continue
        diff, lo, hi = paired_bootstrap(tuned, base)
        out[key] = {'n': len(tuned), 'base': float(np.mean(base)), 'tuned': float(np.mean(tuned)),
                    'diff': diff, 'ci': [lo, hi]}
    return out

# ─── Report ───────────────────────────────────────────────────────────────────


def table(summary):
    rows = ['| Metric | n | Base | clarity-simplify | Difference [95% CI] |', '|---|---|---|---|---|']
    for key, label, scale, _ in METRICS:
        s = summary.get(key)
        if not s:
            continue
        unit = ' pts' if scale == 100 else ''
        rows.append(f"| {label} | {s['n']} | {s['base'] * scale:.2f} | {s['tuned'] * scale:.2f} | "
                    f"{s['diff'] * scale:+.2f}{unit} [{s['ci'][0] * scale:+.2f}, {s['ci'][1] * scale:+.2f}] |")
    return '\n'.join(rows)


def write_report(items, pairs, results, generations_path):
    passed, checks = results['verdict']['passed'], results['verdict']['checks']
    rng = random.Random(SEED)
    examples = rng.sample(pairs, 10)
    first = pairs[0]['base']
    lines = [
        '# Base vs clarity-simplify on ASSET validation (Prompt 10, Part C)',
        '',
        f'Run on {date.today().isoformat()} by `training/evaluate.py`, following `training/eval/PREREG.md` (committed before any generation). '
        f"Items: `training/eval/items.json` ({len(items['sentences'])} sentences + {len(items['paragraphs'])} pseudo-paragraphs of ASSET validation, "
        f"each at target grades {TARGETS[0]} and {TARGETS[1]}: {len(pairs)} prompts per model). Generations: `{generations_path.relative_to(ROOT).as_posix()}`.",
        '',
        f"Models: `{BASE}` and `{TUNED}` in Ollama {first.get('ollamaVersion')}, the app's own prompt (default profile, app hints), "
        'temperature 0, seed 42, GPU.',
        '',
        f"## Verdict: **{'BETTER (all pre-registered criteria met)' if passed else 'NOT BETTER (at least one pre-registered criterion failed)'}**",
        '',
        '| Pre-registered criterion (pooled, point estimate) | Result | Met |',
        '|---|---|---|',
        *[f'| {name} | {res} | {"yes" if ok else "**no**"} |' for name, ok, res in checks],
        '',
        '## Pooled (both targets)',
        '',
        table(results['pooled']),
        '',
    ]
    for t in TARGETS:
        lines += [f'## Target grade {t}', '', table(results['byTarget'][str(t)]), '']
    for kind, label in (('sent', 'Sentences'), ('para', 'Pseudo-paragraphs')):
        lines += [f'## {label} (both targets)', '', table(results['byKind'][kind]), '']
    lines += [
        'Rates are in percentage points. Differences are clarity-simplify minus base, with a paired bootstrap 95% '
        f'interval ({BOOTSTRAP} resamples, seed {SEED}). Entities kept counts only items whose source has an entity. '
        'BERTScore compares the output with the source (meaning kept), not with the references.',
        '',
        '## 10 random examples (seed 42)',
        '',
    ]
    for i, p in enumerate(examples, 1):
        lines += [
            f"### {i}. {p['itemId']} ({p['kind']}), target grade {p['target']}",
            '',
            f"- **Source** (FKGL {p['base']['fkglBefore']}): {p['source']}",
            f"- **Base** (FKGL {p['base']['fkglAfter']}, SARI {p['base']['sari']:.1f}): {p['base']['output']}",
            f"- **clarity-simplify** (FKGL {p['tuned']['fkglAfter']}, SARI {p['tuned']['sari']:.1f}): {p['tuned']['output']}",
            f"- **ASSET reference 1:** {p['references'][0]}",
            '',
        ]
    lines += [
        '## Limitations',
        '',
        '- **Sentence-level evaluation set.** ASSET is single sentences; the 100 pseudo-paragraphs join consecutive validation rows, which are not real paragraphs. Clarity simplifies paragraphs of web pages.',
        '- **Wikipedia domain.** Both the training data (Wiki-Auto) and ASSET come from English Wikipedia; government, health and instruction texts are not tested here.',
        '- **Noisy training data.** Wiki-Auto alignments are automatic (a CRF aligner); some simple sides change or add facts the filters did not catch.',
        '- **Single seed.** One LoRA run and one greedy generation per prompt; run-to-run variance of the fine-tune is not measured.',
        '- **GPU-only timing.** Seconds per 100 words were measured on this PC\'s GPU with temperature 0; CPU-only speed is not measured.',
        '- **Prompt context.** The prompt\'s "current reading level" is the item\'s own estimate; in the app it is the whole document\'s.',
        '- **Training-only choices.** The keep slice (target = source) is never exercised by the app, which skips already-simple paragraphs. Training hints were filtered to words the reference really replaced; the evaluation uses the app\'s unfiltered hints.',
        '- **Metrics.** FKGL is a proxy for reading grade; SARI rewards overlap with crowd references; BERTScore and entity recall check meaning only partly. No human judgement is part of this evaluation.',
        '',
    ]
    (EVAL / 'REPORT.md').write_text('\n'.join(lines), encoding='utf-8', newline='\n')

# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    sys.stdout.reconfigure(encoding='utf-8')  # the Windows console defaults to cp1252
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--generations', default=str(ROOT / 'training' / 'out' / 'eval_generations.jsonl'))
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()

    generations_path = Path(args.generations).resolve()
    items, pairs = load_pairs(generations_path)
    print(f'[Clarity] {len(pairs)} paired prompts; scoring SARI')
    score_sari(pairs)
    print('[Clarity] Scoring BERTScore (roberta-large; the first run downloads it)')
    score_bertscore(pairs)

    pooled = summarise(pairs)
    passed, checks = verdict(pooled)
    results = {
        'prereg': 'training/eval/PREREG.md',
        'models': {'base': BASE, 'tuned': TUNED},
        'sariRevision': SARI_REVISION, 'bertscoreModel': BERTSCORE_MODEL,
        'bootstrap': {'resamples': BOOTSTRAP, 'seed': SEED},
        'pooled': pooled,
        'byTarget': {str(t): summarise([p for p in pairs if p['target'] == t]) for t in TARGETS},
        'byKind': {k: summarise([p for p in pairs if p['kind'] == k]) for k in ('sent', 'para')},
        'verdict': {'passed': passed, 'checks': [[n, ok, r] for n, ok, r in checks]},
        'perItem': [{'itemId': p['itemId'], 'target': p['target'], 'kind': p['kind'],
                     'base': {k: p['base'].get(k) for k in ('sari', 'bertscore', 'fkglAfter', 'gradeHit', 'nearCopy', 'entityRecall', 'secPer100')},
                     'tuned': {k: p['tuned'].get(k) for k in ('sari', 'bertscore', 'fkglAfter', 'gradeHit', 'nearCopy', 'entityRecall', 'secPer100')}}
                    for p in pairs],
    }
    (EVAL / 'results.json').write_text(json.dumps(results, indent=1, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    write_report(items, pairs, results, generations_path)
    print(f"[Clarity] Verdict: {'BETTER' if passed else 'NOT BETTER'}")
    for name, ok, res in checks:
        print(f"[Clarity]   {'met ' if ok else 'FAIL'} {name}: {res}")
    print('[Clarity] Wrote training/eval/results.json and training/eval/REPORT.md')


if __name__ == '__main__':
    main()
