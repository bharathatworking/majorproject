import type { LLMAvailability } from '../../types';

const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen2.5:3b';

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
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    return (async function* () {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line);
            // Ollama's stream yields deltas in message.content, same as
            // Chrome's promptStreaming — accumulate in the caller, don't overwrite.
            if (parsed.message?.content) yield parsed.message.content;
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }

  destroy() {
    this.systemPrompt = '';
  }
}
