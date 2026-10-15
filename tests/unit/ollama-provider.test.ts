import { describe, it, expect, afterEach, vi } from 'vitest';
import { chatModelsFromTags, DEFAULT_LLM_MODEL, OllamaProvider } from '../../src/lib/llm/ollama-provider';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// chatModelsFromTags — Settings model dropdown
// ---------------------------------------------------------------------------
describe('chatModelsFromTags', () => {
  it('lists chat models sorted, without embedding models', () => {
    const tags = {
      models: [
        { name: 'qwen2.5:3b' },
        { name: 'all-minilm:latest' },
        { name: 'llama3.2:1b' },
        { name: 'nomic-embed-text:latest' },
        { name: 'qwen2.5:3b' },
      ],
    };
    expect(chatModelsFromTags(tags)).toEqual(['llama3.2:1b', 'qwen2.5:3b']);
  });

  it('returns an empty list for malformed responses', () => {
    expect(chatModelsFromTags(null)).toEqual([]);
    expect(chatModelsFromTags({})).toEqual([]);
    expect(chatModelsFromTags({ models: [{ name: 3 }, null] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider — model selection
// ---------------------------------------------------------------------------
describe('OllamaProvider', () => {
  it('defaults to qwen2.5:3b', () => {
    expect(DEFAULT_LLM_MODEL).toBe('qwen2.5:3b');
    expect(new OllamaProvider().model).toBe('qwen2.5:3b');
  });

  it('sends the chosen model to /api/chat', async () => {
    const fetchMock = vi.fn(async () => new Response('{"done":true}\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const stream = await new OllamaProvider('llama3.2:1b').simplifyChunk('Hi');
    for await (const _ of stream) { /* drain */ }

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(JSON.parse(String(init.body)).model).toBe('llama3.2:1b');
  });

  it('listModels throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(new OllamaProvider().listModels()).rejects.toMatchObject({ status: 403 });
  });
});
