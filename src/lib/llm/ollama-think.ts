/**
 * Which Ollama models get the `think` field on /api/chat.
 *
 * Design decisions:
 *  - Shared by the app (OllamaProvider) and the base-model bake-off
 *    (scripts/bakeoff/run.mjs), so both decide the same way.
 *  - The rule is the bake-off's: a model whose /api/show `capabilities` list
 *    'thinking' (the qwen3 and gemma4 tags) gets `think: false`, because
 *    Clarity never wants a reasoning trace. Every other model gets no `think`
 *    field at all, since models without the capability reject it.
 *  - Pure: the caller fetches /api/show. Malformed input, or an older Ollama
 *    without `capabilities`, counts as "no thinking".
 */

// ─── Capability ───────────────────────────────────────────────────────────────

/** /api/show capability of models that accept the `think` request field. */
export const THINKING_CAPABILITY = 'thinking';

/**
 * The `think` value to send for a model, from its /api/show response:
 * false for models with the 'thinking' capability, undefined (omit the
 * field) for all others.
 */
export function thinkSetting(show: unknown): false | undefined {
  const capabilities = (show as { capabilities?: unknown } | null)?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes(THINKING_CAPABILITY) ? false : undefined;
}
