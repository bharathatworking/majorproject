/**
 * Echo guard: finds output lines that copy the prompt instead of rewriting
 * the text. In a real run (eval/fixtures/runs/uk-wiki-2026-10-19.json) the
 * model answered a retry with the paragraph plus a line of the prompt's
 * entity list: "- Roman, Roman, 43, 383, 410, 450, 1066, England, Over the
 * 17th century, …". The meaning check scored it as faithful, because every
 * entity was "kept".
 *
 * Design decisions:
 *  - A list line: split at commas and semicolons, at least ECHO_MIN_PARTS
 *    parts, at least ECHO_MIN_SOURCE_SHARE of them source items (an entity
 *    text, a number or year, or a phrase found verbatim in the original that
 *    has a capital or a digit), and no other part longer than
 *    ECHO_MAX_OTHER_WORDS words. A part starting with "and" / "or" is never
 *    a source item: real enumerations end in "…, and Wales", copied lists
 *    don't. Together these keep sentences like "Edinburgh, Cardiff, and
 *    Belfast are the capitals of Scotland, Wales, and Northern Ireland."
 *  - An instruction echo: the output contains wording of the retry or entity
 *    instruction (RETRY_ECHO_PHRASES) that the original doesn't contain.
 *    meaning.test.ts checks that every phrase still occurs in the prompts,
 *    so the list can't go stale.
 *  - Pure (config and types only); meaning.ts turns a finding into the
 *    'echo' failure, and the run loop strips echo lines as a last resort.
 */

import { ECHO_MAX_OTHER_WORDS, ECHO_MIN_PARTS, ECHO_MIN_SOURCE_SHARE } from './config';
import type { Entity } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EchoContext {
  /** The text the model was asked to rewrite. */
  original: string;
  /** Its entities (NER). */
  entities: readonly Entity[];
}

export interface EchoFinding {
  /** Output lines that are copied lists, as written (trimmed). */
  lines: string[];
  /** The output repeats instruction wording. */
  instruction: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Lowercase wording of the retry instruction (meaning.ts
 * buildRetryInstruction) and the entity line (builder.ts), current and
 * older, that never belongs in a rewrite.
 */
export const RETRY_ECHO_PHRASES: readonly string[] = [
  'your last version',
  'work them into your existing sentences',
  'never output a list',
  'output only the rewritten text',
  'do not list them separately',
  'preserve the following entities',
  'fix these problems',
  'you dropped the',
];

/** A list marker at the start of a line: "- ", "* ", "• ", "1. ", "2) ". */
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,3}[.)])\s+/;
const QUOTES = /^["'“‘(]+|["'”’)]+$/g;
const NUMBER = /^\d[\d,.]*s?$/;

// ─── Detection ────────────────────────────────────────────────────────────────

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

const normalize = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/** A line's text without its list marker and closing punctuation. */
function lineCore(line: string): string {
  return line.replace(LIST_MARKER, '').trim().replace(/[.!?;:]+$/, '').trim();
}

/** True when `part` is one of the source's entities or numbers (rules in the file header). */
function isSourceItem(part: string, entityTexts: ReadonlySet<string>, original: string): boolean {
  const p = part.replace(QUOTES, '').trim();
  if (!p || /^(?:and|or)\s/i.test(p)) return false;
  const lower = normalize(p);
  if (entityTexts.has(lower) || entityTexts.has(lower.replace(/^the\s+/, ''))) return true;
  if (NUMBER.test(p)) return true;
  return /[A-Z0-9]/.test(p) && original.includes(lower);
}

/** True when one output line is a copied list (see file header). */
export function isEchoLine(line: string, ctx: EchoContext): boolean {
  const parts = lineCore(line).split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (parts.length < ECHO_MIN_PARTS) return false;
  const entityTexts = new Set(ctx.entities.map(e => normalize(e.text)));
  const original = normalize(ctx.original);
  const items = parts.map(p => isSourceItem(p, entityTexts, original));
  const share = items.filter(Boolean).length / parts.length;
  if (share < ECHO_MIN_SOURCE_SHARE) return false;
  return parts.every((p, i) => items[i] || wordCount(p) <= ECHO_MAX_OTHER_WORDS);
}

/** True when `text` repeats instruction wording the original doesn't have. */
export function echoesInstruction(text: string, original: string): boolean {
  const t = normalize(text);
  const o = normalize(original);
  return RETRY_ECHO_PHRASES.some(phrase => t.includes(phrase) && !o.includes(phrase));
}

/** The copied-list lines and instruction echo of one output. */
export function findEcho(text: string, ctx: EchoContext): EchoFinding {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && isEchoLine(l, ctx));
  return { lines, instruction: echoesInstruction(text, ctx.original) };
}

/**
 * `text` without its copied-list lines and the lines that repeat instruction
 * wording; the run loop's last resort when every version echoed.
 */
export function stripEchoLines(text: string, ctx: EchoContext): string {
  return text
    .split('\n')
    .filter(l => !isEchoLine(l.trim(), ctx) && !echoesInstruction(l, ctx.original))
    .join('\n')
    .trim();
}
