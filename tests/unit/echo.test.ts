import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { echoesInstruction, findEcho, isEchoLine, stripEchoLines } from '../../src/lib/quality/echo';
import { detectEntities } from '../../src/lib/segmentation/ner';
import type { RunLog } from '../../src/types';

// ─── Fixture ──────────────────────────────────────────────────────────────────

/** The 2026-10-19 UK Wikipedia run (eval/fixtures/README.md: dev fixture only). */
const report = JSON.parse(readFileSync('eval/fixtures/runs/uk-wiki-2026-10-19.json', 'utf8')) as { runs: RunLog[] };
const originalOf = (nodeId: string) =>
  report.runs[0].nodes.find(n => n.nodeId === nodeId)?.originalText ?? '';
const contextOf = (nodeId: string) => {
  const original = originalOf(nodeId);
  return { original, entities: detectEntities(original) };
};

/** Every candidate line of the report that starts with `prefix`, as the model wrote it. */
function leakedLines(prefix: string): string[] {
  return report.runs
    .flatMap(r => r.nodes)
    .flatMap(n => n.candidates.map(c => ({ nodeId: n.nodeId, text: c.text ?? '' })))
    .flatMap(({ nodeId, text }) => text.split('\n').map(line => ({ nodeId, line: line.trim() })))
    .filter(({ line }) => line.startsWith(prefix))
    .map(({ nodeId, line }) => `${nodeId}\t${line}`);
}

// ─── Copied lists ─────────────────────────────────────────────────────────────

describe('isEchoLine: the leaked lines of the UK run', () => {
  const leaked = [
    ...leakedLines('- Roman, Roman, 43'),
    ...leakedLines('- Roman, 43, 383'),
    ...leakedLines('- Britain, Kingdom of England'),
    ...leakedLines('- Scotland, Wales, Northern Ireland, Northern Ireland'),
  ];

  it('finds the five leaked lines in the report', () => {
    expect(leaked.map(l => l.split('\t')[0])).toEqual(['n1', 'n1', 'n1', 'n5', 'n6']);
  });

  it.each(leaked.map(l => l.split('\t') as [string, string]))('%s: rejects %s', (nodeId, line) => {
    expect(isEchoLine(line, contextOf(nodeId))).toBe(true);
  });
});

describe('isEchoLine: real sentences with lists are kept', () => {
  it.each([
    ['n0', 'England, Scotland and Wales are countries.'],
    ['n0', '- It includes England, Scotland, Wales, and Northern Ireland.'],
    ['n0', '- It is surrounded by the Atlantic Ocean, North Sea, English Channel, Celtic Sea, and Irish Sea.'],
    ['n0', '- Edinburgh, Cardiff, and Belfast are the capitals of Scotland, Wales, and Northern Ireland.'],
    ['n3', '- British culture is seen in law, politics, books, films, music, media, art, and sports.'],
    ['n3', '- The UK has three parts: England, Wales, Scotland, and Northern Ireland.'],
    ['n1', '- In 1800, Ireland joined to form the United Kingdom of Great Britain and Ireland in 1801.'],
  ])('%s: keeps %s', (nodeId, line) => {
    expect(isEchoLine(line, contextOf(nodeId))).toBe(false);
  });

  it('keeps every line of the outputs the run kept without a leak', () => {
    const n0 = report.runs[0].nodes.find(n => n.nodeId === 'n0');
    const text = n0?.candidates[0].text ?? '';
    expect(findEcho(text, contextOf('n0')).lines).toEqual([]);
  });
});

// ─── Instruction echo ─────────────────────────────────────────────────────────

describe('echoesInstruction', () => {
  it('finds retry or entity-line wording in an output', () => {
    expect(echoesInstruction('The UK is in Europe. Never output a list of names.', originalOf('n0'))).toBe(true);
    expect(echoesInstruction('Preserve the following entities: UK.', originalOf('n0'))).toBe(true);
    expect(echoesInstruction('Your last version left out Rome.', originalOf('n0'))).toBe(true);
  });

  it('ignores normal text and wording the original itself has', () => {
    expect(echoesInstruction('The UK is a country in Europe.', originalOf('n0'))).toBe(false);
    expect(echoesInstruction('He read your last version aloud.', 'She asked about your last version of the plan.')).toBe(false);
  });
});

// ─── Findings and stripping ───────────────────────────────────────────────────

describe('findEcho / stripEchoLines', () => {
  const stepwise = report.runs[4].nodes.find(n => n.nodeId === 'n1')?.candidates[1].text ?? '';

  it('the n1 stepwise candidate of the Full run has exactly one echo line', () => {
    const finding = findEcho(stepwise, contextOf('n1'));
    expect(finding.lines).toHaveLength(1);
    expect(finding.lines[0].startsWith('- Roman, Roman, 43')).toBe(true);
    expect(finding.instruction).toBe(false);
  });

  it('strips only the echo line', () => {
    const stripped = stripEchoLines(stepwise, contextOf('n1'));
    expect(stripped).not.toContain('Roman, Roman');
    expect(stripped.split('\n')).toHaveLength(stepwise.trim().split('\n').length - 1);
    expect(findEcho(stripped, contextOf('n1')).lines).toEqual([]);
  });
});
