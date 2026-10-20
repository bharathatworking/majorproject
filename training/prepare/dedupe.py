"""
Removes every Wiki-Auto pair whose English (complex) side overlaps a
reserved text, and writes the reserved set for the TypeScript re-check.

  python training/prepare/dedupe.py              # data/wikiauto_pairs.jsonl -> data/wikiauto_dedup.jsonl
  python training/prepare/dedupe.py --self-test  # the shared cases in scripts/train-data/dedupe-cases.json

Design decisions:
 - Normalise = NFKC, lowercase, remove Unicode punctuation (P*) and symbols
   (S*), collapse whitespace. A pair is dropped when its complex side equals
   a reserved text after normalising, or when the 8-gram containment is
   >= 0.5 in either direction: the share of the pair's 8-grams found in one
   reserved source, or the share of one reserved item's 8-grams found in the
   pair (this catches a reserved sentence inside a longer text).
 - The same matcher is written in TypeScript (scripts/train-data/lib.ts,
   reservedHits). Both run dedupe-cases.json, and build-sft.mjs re-checks
   every selected example against data/reserved.jsonl and aborts on a hit.
 - Reserved sources: ASSET val + test, TurkCorpus val + test (originals),
   the calibration originals and their simplifications (eval/nli-calibration),
   the bake-off paragraphs (eval/model-bakeoff), every node originalText in
   eval/fixtures/runs/*.json plus eval/fixtures/uk-wiki-paste.txt, and any
   eval/benchmark* folder (a JSONL `text`/`original` field), none today.
 - A pair can match several sources; each is counted, plus the unique total.
"""

import argparse
import json
import sys
import unicodedata
from pathlib import Path

# ─── Config ───────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'training' / 'data'
EVAL = ROOT / 'eval'
CASES = ROOT / 'scripts' / 'train-data' / 'dedupe-cases.json'
NGRAM = 8
OVERLAP_MIN = 0.5

# ─── Matcher ──────────────────────────────────────────────────────────────────


def normalise(text):
    text = unicodedata.normalize('NFKC', text).lower()
    text = ''.join(c for c in text if unicodedata.category(c)[0] not in 'PS')
    return ' '.join(text.split())


def ngrams(norm, n=NGRAM):
    words = norm.split(' ') if norm else []
    return {' '.join(words[i:i + n]) for i in range(len(words) - n + 1)}


class ReservedIndex:
    def __init__(self, items):
        self.exact = {}
        self.grams = {}
        self.items = []
        self.by_source = {}
        for source, text in items:
            norm = normalise(text)
            if not norm:
                continue
            self.exact.setdefault(norm, set()).add(source)
            grams = ngrams(norm)
            item_id = len(self.items)
            self.items.append((source, len(grams)))
            bucket = self.by_source.setdefault(source, set())
            for g in grams:
                bucket.add(g)
                self.grams.setdefault(g, []).append(item_id)

    def hits(self, text):
        """Sorted reserved sources the text overlaps."""
        norm = normalise(text)
        found = set(self.exact.get(norm, ()))
        grams = ngrams(norm)
        if grams:
            per_item = {}
            per_source = {}
            for g in grams:
                ids = self.grams.get(g)
                if not ids:
                    continue
                for i in ids:
                    per_item[i] = per_item.get(i, 0) + 1
                for source, bucket in self.by_source.items():
                    if g in bucket:
                        per_source[source] = per_source.get(source, 0) + 1
            for source, count in per_source.items():
                if count / len(grams) >= OVERLAP_MIN:
                    found.add(source)
            for i, count in per_item.items():
                source, gram_count = self.items[i]
                if count / gram_count >= OVERLAP_MIN:
                    found.add(source)
        return sorted(found)

# ─── Reserved texts ───────────────────────────────────────────────────────────


def read_jsonl(path):
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def reserved_items():
    items = []
    for key, source in [('asset_val', 'asset-val'), ('asset_test', 'asset-test'),
                        ('turk_val', 'turk-val'), ('turk_test', 'turk-test')]:
        path = DATA / f'{key}.jsonl'
        if not path.exists():
            sys.exit(f'[Clarity] {path} is missing: run training/prepare/download.py first')
        items += [(source, r['original']) for r in read_jsonl(path)]

    calib = EVAL / 'nli-calibration'
    for r in read_jsonl(calib / 'paragraphs.jsonl'):
        items.append(('nli-calibration', r['text']))
        if r.get('simplification'):
            items.append(('nli-calibration', r['simplification']))
    for r in read_jsonl(calib / 'paragraph-items.jsonl'):
        if r.get('simplified'):
            items.append(('nli-calibration', r['simplified']))

    items += [('model-bakeoff', r['text']) for r in read_jsonl(EVAL / 'model-bakeoff' / 'paragraphs.jsonl')]

    for path in sorted((EVAL / 'fixtures' / 'runs').glob('*.json')):
        report = json.loads(path.read_text(encoding='utf-8'))
        for run in report.get('runs', []):
            items += [('fixtures', n['originalText']) for n in run.get('nodes', []) if n.get('originalText')]
    paste = EVAL / 'fixtures' / 'uk-wiki-paste.txt'
    if paste.exists():
        items += [('fixtures', block) for block in paste.read_text(encoding='utf-8').split('\n\n') if block.strip()]

    for folder in sorted(p for p in EVAL.glob('benchmark*') if p.is_dir()):
        for path in sorted(folder.rglob('*.jsonl')):
            for r in read_jsonl(path):
                text = r.get('text') or r.get('original')
                if not text:
                    sys.exit(f'[Clarity] {path}: a benchmark-reserve row without text/original; extend dedupe.py before training')
                items.append(('benchmark-reserve', text))
    return items

# ─── Self-test ────────────────────────────────────────────────────────────────


def self_test():
    cases = json.loads(CASES.read_text(encoding='utf-8'))
    failures = 0
    for c in cases['normalise']:
        got = normalise(c['in'])
        if got != c['out']:
            failures += 1
            print(f'[Clarity] FAIL normalise {c["in"]!r}: {got!r} != {c["out"]!r}')
    for c in cases['match']:
        index = ReservedIndex([(r['source'], r['text']) for r in c['reserved']])
        got = index.hits(c['text'])
        if got != c['expected']:
            failures += 1
            print(f'[Clarity] FAIL match ({c["why"]}): {got} != {c["expected"]}')
    total = len(cases['normalise']) + len(cases['match'])
    print(f'[Clarity] dedupe self-test: {total - failures}/{total} cases pass')
    sys.exit(1 if failures else 0)

# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--self-test', action='store_true', help='run the shared matcher cases and exit')
    args = parser.parse_args()
    if args.self_test:
        self_test()

    items = reserved_items()
    index = ReservedIndex(items)
    reserved_counts = {}
    for source, _ in items:
        reserved_counts[source] = reserved_counts.get(source, 0) + 1
    print(f'[Clarity] Reserved texts: {reserved_counts}')

    with open(DATA / 'reserved.jsonl', 'w', encoding='utf-8', newline='\n') as f:
        for source, text in items:
            f.write(json.dumps({'source': source, 'text': text}, ensure_ascii=False) + '\n')

    removed_by_source = {s: 0 for s in reserved_counts}
    total = kept = removed = 0
    examples = []
    with open(DATA / 'wikiauto_pairs.jsonl', encoding='utf-8') as src, \
         open(DATA / 'wikiauto_dedup.jsonl', 'w', encoding='utf-8', newline='\n') as out:
        for line in src:
            total += 1
            pair = json.loads(line)
            hits = index.hits(pair['complex'])
            if hits:
                removed += 1
                for h in hits:
                    removed_by_source[h] += 1
                if len(examples) < 5:
                    examples.append({'id': pair['id'], 'sources': hits, 'complex': pair['complex'][:200]})
                continue
            kept += 1
            out.write(line if line.endswith('\n') else line + '\n')
            if total % 100000 == 0:
                print(f'[Clarity] dedupe: {total} pairs read, {removed} removed')

    report = {
        'input': total, 'kept': kept, 'removedUnique': removed,
        'removedBySource': removed_by_source, 'reservedTexts': reserved_counts,
        'ngram': NGRAM, 'overlapMin': OVERLAP_MIN, 'examples': examples,
    }
    with open(DATA / 'dedupe_report.json', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'[Clarity] dedupe: {total} pairs, {removed} removed, {kept} kept')
    for source, n in removed_by_source.items():
        print(f'[Clarity]   removed for {source}: {n}')


if __name__ == '__main__':
    main()
