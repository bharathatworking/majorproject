import type { ContentNode, SimplificationSpec, ReadabilityReport } from '../../types';

// ─── Reader rules ─────────────────────────────────────────────────────────────

/**
 * Turns the spec's reader flags (from readingPurpose and domainFamiliarity)
 * into explicit instructions. keepTerms and explainTerms are mutually
 * exclusive in resolveProfile; keepTerms is checked first regardless.
 */
export function readerRules(spec: SimplificationSpec): string[] {
  const rules: string[] = [];
  if (spec.avoidIdioms) {
    rules.push(
      "Avoid idioms, phrasal verbs (such as 'put off' or 'figure out') and figurative language. " +
      'Prefer common, everyday words. Keep sentences short.',
    );
  }
  if (spec.oneIdeaPerSentence) {
    rules.push(
      'Put only one idea in each sentence. Keep paragraphs short (at most 3 sentences); ' +
      'separate paragraphs with a blank line.',
    );
  }
  if (spec.keepTerms) {
    rules.push(
      'The reader knows this field. Keep technical terms as they are; simplify only the sentence structure.',
    );
  } else if (spec.explainTerms) {
    rules.push(
      'The first time a technical term appears, explain it briefly in brackets, ' +
      "e.g. 'photosynthesis (how plants make food from sunlight)'.",
    );
  }
  return rules;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Returns the grade-level description for a given depth tier.
 * Having this as a named function (rather than an inline object index) means
 * TypeScript enforces exhaustiveness and there is no `undefined` path.
 */
function gradeLevelDescription(spec: SimplificationSpec): string {
  switch (spec.depthTier) {
    case 'none':       return 'the original grade level — do NOT simplify';
    case 'light':      return `around grade ${spec.targetGrade}`;
    case 'moderate':   return `exactly grade ${spec.targetGrade}`;
    case 'aggressive': return `below grade ${spec.targetGrade}, as simple as possible`;
    default: {
      // Defensive: if a new tier is added and not handled, fail loudly at runtime
      const _exhaustive: never = spec.depthTier;
      return `grade ${spec.targetGrade}`;
    }
  }
}

/**
 * Builds a per-node {system, user} prompt pair for the Ollama chat API.
 *
 * The system prompt is shared across all nodes in a run (stored once by
 * OllamaProvider.createBaseSession and sent with every /api/chat request).
 * The user prompt is node-specific and includes:
 *  - A node-type hint so the model knows structural constraints
 *    (headings stay short; list-items stay parallel; etc.)
 *  - An optional entity preservation instruction
 *  - An optional rolling context sentence from the previous node
 *  - An optional lexical hint listing words the common-word list flags as
 *    hard (findDifficultWords). It is left out when the reader keeps terms or
 *    the tier is 'none', where it would contradict the system prompt.
 */
export function buildPrompt(
  node: ContentNode,
  spec: SimplificationSpec,
  report: ReadabilityReport,
  previousContext: string = '',
  difficultWords: string[] = [],
): { system: string; user: string } {

  const extraRules = readerRules(spec)
    .map((rule, i) => `${7 + i}. ${rule}\n`)
    .join('');

  // ── System prompt (reused for all nodes in the session) ──────────────────
  const system = `You are an expert editor and plain-language summarizer. \
Your job is to rewrite the text provided by the user to match a specific reading level and style.
CRITICAL INSTRUCTIONS:
1. Target reading level: ${gradeLevelDescription(spec)}. \
Current reading level is estimated at grade ${report.estimatedGradeLevel.toFixed(1)}.
2. Tone/Style: ${spec.style}. ${spec.tone ? `Tone should be ${spec.tone}.` : ''}
3. Preserve meaning, facts, and structure. Do NOT add new information, opinions, or meta-commentary.
4. Output ONLY the rewritten text. Do NOT add markdown (no headings, bold, italics or tables). \
Do NOT explain your reasoning, list which entities were preserved, add a verification \
checklist, or include any commentary about the rewrite itself — output the rewritten \
text and nothing else.
5. Max sentence length: ${spec.maxSentenceLength} words.
${spec.allowBullets
    ? "6. You may use bullet points where they aid clarity. Put each bullet on its own line starting with '- '. Use no other markdown."
    : '6. Write plain sentences. No bullets or lists.'}
${extraRules}`;

  // ── User prompt (per-node) ────────────────────────────────────────────────

  // Node-type hint — tells the model the structural role of this text so it
  // doesn't, e.g., expand a 3-word heading into a paragraph.
  let typeHint = '';
  if (node.type === 'heading') {
    typeHint =
      `This is a heading (level ${node.level ?? 1}). ` +
      `Keep it SHORT — do not expand it into a sentence or paragraph. ` +
      `Preserve its role as a section title.\n\n`;
  } else if (node.type === 'list-item') {
    typeHint =
      `This is one item in a list. ` +
      `Keep it parallel in structure and length to a typical list item. ` +
      `Do not turn it into a full paragraph.\n\n`;
  } else if (node.type === 'blockquote') {
    typeHint =
      `This is a blockquote. Simplify it but preserve its quoted/cited nature.\n\n`;
  }

  let user = typeHint;

  if (previousContext) {
    user += `[Context from previous section: "${previousContext}"]\n\n`;
  }

  user += `Please rewrite the following text according to the system instructions.\n\n`;

  if (spec.preserveEntities && node.entities && node.entities.length > 0) {
    const entityList = node.entities.map(e => e.text).join(', ');
    user += `IMPORTANT: Preserve the following entities EXACTLY as written: ${entityList}\n\n`;
  }

  if (difficultWords.length > 0 && !spec.keepTerms && spec.depthTier !== 'none') {
    user +=
      'These words may be hard for the reader. Replace them with simpler words ' +
      `or briefly explain them: ${difficultWords.join(', ')}\n\n`;
  }

  user += `TEXT TO REWRITE:\n${node.text}`;

  return { system, user };
}
