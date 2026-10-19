/**
 * Ollama client for the local chat model and the embedding model.
 *
 * The chat model is chosen by the user (sync `llmModel`, see
 * lib/storage/settings.ts) and passed to the constructor; DEFAULT_LLM_MODEL
 * applies when nothing is saved. Only localhost:11434 is contacted, which the
 * CSP connect-src and host_permissions already allow.
 *
 * createBaseSession reads the model's /api/show once: a 404 there means the
 * model is not pulled (caught before any node runs), and its capabilities
 * decide the `think` field (ollama-think.ts). No temperature is sent; each
 * model uses its Modelfile default.
 */

import type { LLMAvailability } from '../../types';
import { thinkSetting } from './ollama-think';
import { parseOllamaStream } from './ollama-stream';

const OLLAMA_BASE_URL = 'http://localhost:11434';
/**
 * Chat model used until the user picks another one in Settings. The winner
 * of the Prompt 9.4 base-model bake-off (eval/model-bakeoff/REPORT.md),
 * licensed Apache 2.0. A model saved in sync `llmModel` always wins over it.
 */
export const DEFAULT_LLM_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
/** Lighter chat model Settings suggests for slower computers. */
export const LIGHT_LLM_MODEL = 'qwen2.5:1.5b';
/**
 * Sentence-BERT embedding model (all-MiniLM-L6-v2, ~23M params) used by the
 * meaning check in lib/quality/semantic.ts. Optional: a 404 skips the check.
 */
export const EMBED_MODEL = 'all-minilm';

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Non-OK HTTP response from Ollama; `status` lets callers map 403/404 to advice. */
export class OllamaHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Ollama request failed: ${status}`);
    this.name = 'OllamaHttpError';
  }
}

// ─── Model list ───────────────────────────────────────────────────────────────

/**
 * Chat-capable model names from an /api/tags response, sorted. Embedding
 * models (EMBED_MODEL and anything named *embed*) can't answer /api/chat, so
 * they are left out. Malformed input yields an empty list.
 */
export function chatModelsFromTags(json: unknown): string[] {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const names = models
    .map(m => (m as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .filter(n => !n.toLowerCase().includes('embed') && n.split(':')[0] !== EMBED_MODEL);
  return [...new Set(names)].sort();
}

// ─── Missing model ────────────────────────────────────────────────────────────

/**
 * Console line for a chat model that isn't installed, with the pull command
 * (and the default's when another model is missing). The command goes to the
 * console and README only, never into text the reader sees.
 */
export function missingModelLog(model: string): string {
  const fallback = model === DEFAULT_LLM_MODEL ? '' : ` (default model: ollama pull ${DEFAULT_LLM_MODEL})`;
  return `[Clarity] Model ${model} is not installed in Ollama. Run: ollama pull ${model}${fallback}`;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OllamaProvider {
  private systemPrompt: string = '';
  /** `think` for /api/chat, set by createBaseSession; undefined = omit the field. */
  private think: false | undefined;

  constructor(readonly model: string = DEFAULT_LLM_MODEL) {}

  async checkAvailability(): Promise<LLMAvailability> {
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      return res.ok ? 'available' : 'unavailable';
    } catch (e) {
      // Connection refused (Ollama not running) or CORS rejection
      // (OLLAMA_ORIGINS not set) both land here.
      console.error('[Clarity] Ollama not reachable:', e);
      return 'unavailable';
    }
  }

  /** Installed chat models (GET /api/tags). Throws when Ollama is unreachable. */
  async listModels(): Promise<string[]> {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!res.ok) throw new OllamaHttpError(res.status);
    return chatModelsFromTags(await res.json());
  }

  /** The model's /api/show response. Throws OllamaHttpError (404 = model not pulled). */
  async show(): Promise<unknown> {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model }),
    });
    if (!res.ok) throw new OllamaHttpError(res.status);
    return res.json();
  }

  async createBaseSession(
    systemText: string,
    _onProgress?: (loaded: number, total: number) => void,
  ): Promise<void> {
    // Ollama's /api/chat is stateless per-request — there's no persistent
    // session object like Chrome's LanguageModel. We just store the system
    // prompt and include it on every call in simplifyChunk.
    // _onProgress is accepted for interface compatibility but unused:
    // Ollama models are pulled via `ollama pull` outside the browser.
    this.systemPrompt = systemText;
    this.think = thinkSetting(await this.show());
  }

  async simplifyChunk(userText: string): Promise<AsyncIterable<string>> {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: userText },
        ],
        stream: true,
        keep_alive: '10m',  // keep the model resident so only the first call in a
                            // session pays the cold-load cost, not every call
        ...(this.think !== undefined && { think: this.think }),
      }),
    });

    if (!response.ok || !response.body) {
      throw new OllamaHttpError(response.status);
    }

    return parseOllamaStream(readerChunks(response.body.getReader()));
  }

  /**
   * One embedding vector per input text, in order. Throws OllamaHttpError on a
   * non-OK response (404 = EMBED_MODEL not pulled). Same origin as /api/chat,
   * so the existing CSP connect-src and host_permissions already cover it.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: '10m' }),
    });

    if (!response.ok) throw new OllamaHttpError(response.status);

    const data = (await response.json()) as { embeddings?: unknown };
    const { embeddings } = data;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error('Ollama /api/embed returned an unexpected response');
    }
    return embeddings as number[][];
  }

  destroy() {
    this.systemPrompt = '';
  }
}

// ─── Stream helpers ───────────────────────────────────────────────────────────

/**
 * Adapts a stream reader to an async iterable. The `finally` also runs when
 * the parser stops early (done line, error line) or the consumer breaks, so
 * the lock is always released.
 */
async function* readerChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
