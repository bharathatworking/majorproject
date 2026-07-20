import type { ContentNode, SimplificationSpec, ReadabilityReport } from '../../types';

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
 * Builds a per-node {system, user} prompt pair for the LanguageModel API.
 *
 * The system prompt is shared across all nodes in a session (set once via
 * initialPrompts). The user prompt is node-specific and includes:
 *  - A node-type hint so the model knows structural constraints
 *    (headings stay short; list-items stay parallel; etc.)
 *  - An optional entity preservation instruction
 *  - An optional rolling context sentence from the previous node
 */
export function buildPrompt(
  node: ContentNode,
  spec: SimplificationSpec,
  report: ReadabilityReport,
  previousContext: string = '',
): { system: string; user: string } {

  // ── System prompt (reused for all nodes in the session) ──────────────────
  const system = `You are an expert editor and plain-language summarizer. \
Your job is to rewrite the text provided by the user to match a specific reading level and style.
CRITICAL INSTRUCTIONS:
1. Target reading level: ${gradeLevelDescription(spec)}. \
Current reading level is estimated at grade ${report.estimatedGradeLevel.toFixed(1)}.
2. Tone/Style: ${spec.style}. ${spec.tone ? `Tone should be ${spec.tone}.` : ''}
3. Preserve meaning, facts, and structure. Do NOT add new information, opinions, or meta-commentary.
4. Output ONLY the rewritten text. Do NOT add markdown unless requested. \
Do NOT explain your reasoning, list which entities were preserved, add a verification \
checklist, or include any commentary about the rewrite itself — output the rewritten \
text and nothing else.
5. Max sentence length: ${spec.maxSentenceLength} words.
${spec.allowBullets
    ? '6. You may use bullet points where they aid clarity.'
    : '6. Do NOT use bullet points or dashes for list formatting.'}
`;

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

  user += `TEXT TO REWRITE:\n${node.text}`;

  return { system, user };
}
