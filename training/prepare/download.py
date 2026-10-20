"""
Downloads the Prompt 10 data as plain parquet and writes small JSONL files
under training/data/ (git-ignored).

  python training/prepare/download.py [--max-shards N]

Design decisions:
 - Parquet only, through huggingface_hub + pyarrow. No `datasets` loader
   script ever runs (the official Wiki-Auto repo ships one, wiki_auto.py);
   the files come from the Hub's own parquet conversion branch
   `refs/convert/parquet`. The resolved commit SHA of every source is written
   to data/SOURCES.json so a later download can be compared.
 - Wiki-Auto, config `auto` (Jiang et al., 2020): whole English / Simple
   English article pairs with ordered sentences and the CRF sentence
   alignment. A training pair is one connected component of the alignment
   graph, so 1->n splits and n->1 merges stay whole; each side is its
   sentences joined in article order. Sentence ids look like
   `normal-<article>-<paragraph>-<sentence>`, which gives the article id, the
   paragraph and the order that the pseudo-paragraphs (build-sft.mjs) need.
 - ASSET (Alva-Manchego et al., 2020) validation keeps its 10 references:
   it is the Part C evaluation set. ASSET test and TurkCorpus validation and
   test are kept as originals only: they exist here for dedupe.py and are
   reserved for the final benchmark, so no output can be scored on them.
"""

import argparse
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download

# ─── Config ───────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'training' / 'data'
RAW = DATA / 'raw'
PARQUET_REV = 'refs/convert/parquet'

WIKI_AUTO = {
    'repo': 'chaojiang06/wiki_auto',
    'name': 'Wiki-Auto (config auto)',
    'license': 'CC BY-SA 3.0 (the alignments are not licensed separately; the Wikipedia text is CC BY-SA)',
    'citation': 'Jiang, Maddela, Lan, Zhong and Xu (2020). Neural CRF Model for Sentence Alignment in Text Simplification. ACL 2020, 7943-7960.',
}
ASSET = {
    'repo': 'facebook/asset',
    'name': 'ASSET (config simplification)',
    'license': 'CC BY-NC 4.0 per the dataset card text (its metadata tag says CC BY-SA 4.0); evaluation use only',
    'citation': 'Alva-Manchego, Martin, Bordes, Scarton, Sagot and Specia (2020). ASSET. ACL 2020, 4668-4679.',
}
TURK = {
    'repo': 'community-datasets/turk',
    'name': 'TurkCorpus (config simplification)',
    'license': 'GPL-3.0 per the original TurkCorpus release; used here only to exclude its sentences from training',
    'citation': 'Xu, Napoles, Pavlick, Chen and Callison-Burch (2016). Optimizing Statistical Machine Translation for Text Simplification. TACL 4, 401-415.',
}

# ─── Hub ──────────────────────────────────────────────────────────────────────


def parquet_files(api, repo, prefix):
    """The parquet files under `prefix` on the conversion branch, sorted."""
    files = api.list_repo_files(repo, repo_type='dataset', revision=PARQUET_REV)
    found = sorted(f for f in files if f.startswith(prefix) and f.endswith('.parquet'))
    if not found:
        sys.exit(f'[Clarity] {repo}: no parquet files under {prefix} on {PARQUET_REV}. '
                 'The source may have moved; stop here and tell the author (no WikiLarge fallback is written).')
    return found


def fetch(repo, filename):
    """Downloads one file of the conversion branch into training/data/raw/ (cached)."""
    return hf_hub_download(repo, filename, repo_type='dataset', revision=PARQUET_REV, local_dir=RAW / repo.replace('/', '__'))


def revision_sha(api, repo):
    return api.dataset_info(repo, revision=PARQUET_REV).sha


def write_jsonl(path, rows):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

# ─── Wiki-Auto ────────────────────────────────────────────────────────────────


def as_records(value, keys):
    """A HF Sequence of structs is stored either as a list of dicts or as a dict of lists."""
    if value is None:
        return []
    if isinstance(value, dict):
        columns = [value.get(k) or [] for k in keys]
        return [dict(zip(keys, row)) for row in zip(*columns)]
    return [{k: item.get(k) for k in keys} for item in value]


def paragraph_of(sentence_id):
    """`normal-41918715-1-0` -> 1; None when the id has another shape."""
    parts = sentence_id.split('-')
    if len(parts) >= 4 and parts[-1].isdigit() and parts[-2].isdigit():
        return int(parts[-2])
    return None


def components(edges):
    """Connected components of a bipartite alignment graph, as (normal ids, simple ids)."""
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for n, s in edges:
        parent[find(('n', n))] = find(('s', s))
    groups = {}
    for node in list(parent):
        groups.setdefault(find(node), []).append(node)
    return [([v for k, v in g if k == 'n'], [v for k, v in g if k == 's']) for g in groups.values()]


def article_pairs(row):
    """Every aligned component of one article pair, in English sentence order."""
    normal, simple = row['normal'], row['simple']
    article_id = normal['normal_article_id']
    n_sents = as_records(normal['normal_article_content'], ['normal_sentence_id', 'normal_sentence'])
    s_sents = as_records(simple['simple_article_content'], ['simple_sentence_id', 'simple_sentence'])
    n_index = {r['normal_sentence_id']: i for i, r in enumerate(n_sents)}
    s_index = {r['simple_sentence_id']: i for i, r in enumerate(s_sents)}
    edges = [
        (e['normal_sentence_id'], e['simple_sentence_id'])
        for e in as_records(row['sentence_alignment'], ['normal_sentence_id', 'simple_sentence_id'])
        if e['normal_sentence_id'] in n_index and e['simple_sentence_id'] in s_index
    ]
    pairs = []
    for normal_ids, simple_ids in components(edges):
        n_idx = sorted(n_index[i] for i in normal_ids)
        s_idx = sorted(s_index[i] for i in simple_ids)
        paragraphs = {paragraph_of(n_sents[i]['normal_sentence_id']) for i in n_idx}
        pairs.append({
            'id': f'wa-{article_id}-{n_idx[0]}',
            'articleId': article_id,
            'normalIdx': n_idx,
            'paraKey': paragraphs.pop() if len(paragraphs) == 1 else None,
            'complex': ' '.join(n_sents[i]['normal_sentence'].strip() for i in n_idx),
            'simple': ' '.join(s_sents[i]['simple_sentence'].strip() for i in s_idx),
        })
    return sorted(pairs, key=lambda p: p['normalIdx'][0])


def download_wiki_auto(api, max_shards):
    files = parquet_files(api, WIKI_AUTO['repo'], 'auto/')
    files = files[:max_shards] if max_shards else files
    out = DATA / 'wikiauto_pairs.jsonl'
    articles = pairs = 0
    sample_id = None
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        for name in files:
            path = fetch(WIKI_AUTO['repo'], name)
            pf = pq.ParquetFile(path)
            for batch in pf.iter_batches(batch_size=256, columns=['normal', 'simple', 'sentence_alignment']):
                for row in batch.to_pylist():
                    articles += 1
                    if sample_id is None:
                        content = as_records(row['normal']['normal_article_content'], ['normal_sentence_id', 'normal_sentence'])
                        sample_id = content[0]['normal_sentence_id'] if content else None
                    for p in article_pairs(row):
                        f.write(json.dumps(p, ensure_ascii=False) + '\n')
                        pairs += 1
            print(f'[Clarity] Wiki-Auto {name}: {articles} articles, {pairs} aligned pairs so far')
    print(f'[Clarity] Wiki-Auto sentence id format, e.g. {sample_id!r} (prefix-article-paragraph-sentence)')
    return {'files': files, 'articles': articles, 'pairs': pairs, 'output': out.name}

# ─── ASSET and TurkCorpus ─────────────────────────────────────────────────────


def read_split(api, source, split):
    rows = []
    for name in parquet_files(api, source['repo'], f'simplification/{split}/'):
        rows.extend(pq.read_table(fetch(source['repo'], name)).to_pylist())
    return rows, name


def download_eval(api):
    stats = {}
    val, _ = read_split(api, ASSET, 'validation')
    write_jsonl(DATA / 'asset_val.jsonl', (
        {'idx': i, 'original': r['original'], 'references': list(r['simplifications'])} for i, r in enumerate(val)
    ))
    refs = {len(r['simplifications']) for r in val}
    stats['asset_val'] = {'rows': len(val), 'referencesPerRow': sorted(refs)}
    for source, split, key in [(ASSET, 'test', 'asset_test'), (TURK, 'validation', 'turk_val'), (TURK, 'test', 'turk_test')]:
        rows, _ = read_split(api, source, split)
        # Originals only: these splits are reserved; without references nothing can be scored on them
        write_jsonl(DATA / f'{key}.jsonl', ({'idx': i, 'original': r['original']} for i, r in enumerate(rows)))
        stats[key] = {'rows': len(rows)}
    for key, s in stats.items():
        print(f'[Clarity] {key}: {s}')
    return stats

# ─── Main ─────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--max-shards', type=int, default=0, help='Wiki-Auto parquet shards to read (0 = all of config auto)')
    parser.add_argument('--skip-wiki-auto', action='store_true', help='only (re)download ASSET and TurkCorpus')
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    api = HfApi()

    sources = {}
    for source in (WIKI_AUTO, ASSET, TURK):
        sources[source['repo']] = {**source, 'revision': PARQUET_REV, 'sha': revision_sha(api, source['repo'])}
        print(f"[Clarity] Source: {source['name']} ({source['repo']} @ {sources[source['repo']]['sha'][:10]}). Licence: {source['license']}")

    if not args.skip_wiki_auto:
        sources[WIKI_AUTO['repo']]['stats'] = download_wiki_auto(api, args.max_shards)
    eval_stats = download_eval(api)
    sources[ASSET['repo']]['stats'] = {k: v for k, v in eval_stats.items() if k.startswith('asset')}
    sources[TURK['repo']]['stats'] = {k: v for k, v in eval_stats.items() if k.startswith('turk')}

    with open(DATA / 'SOURCES.json', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(sources, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'[Clarity] Wrote {DATA / "SOURCES.json"}')


if __name__ == '__main__':
    main()
