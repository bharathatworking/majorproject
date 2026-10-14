import type { LLMAvailability } from '../../types';
import { parseOllamaStream } from './ollama-stream';

const OLLAMA_BASE_URL = 'http://localhost:11434';
export const OLLAMA_MODEL = 'qwen2.5:3b';

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Non-OK HTTP response from Ollama; `status` lets callers map 403/404 to advice. */
export class OllamaHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Ollama request failed: ${status}`);
    this.name = 'OllamaHttpError';
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OllamaProvider {
  private systemPrompt: string = '';

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
  }

  async simplifyChunk(userText: string): Promise<AsyncIterable<string>> {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: userText },
        ],
        stream: true,
        keep_alive: '10m',  // keep the model resident so only the first call in a
                            // session pays the cold-load cost, not every call
      }),
    });

    if (!response.ok || !response.body) {
      throw new OllamaHttpError(response.status);
    }

    return parseOllamaStream(readerChunks(response.body.getReader()));
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
