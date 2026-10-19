import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  chatModelsFromTags, DEFAULT_LLM_MODEL, missingModelLog, OllamaProvider,
} from '../../src/lib/llm/ollama-provider';
import { THINKING_CAPABILITY, thinkSetting } from '../../src/lib/llm/ollama-think';
import { getLlmModel, saveLlmModel } from '../../src/lib/storage/settings';
import { installChromeMock } from '../mocks/chrome';

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
  it('defaults to the bake-off winner, qwen3:4b-instruct-2507-q4_K_M', () => {
    expect(DEFAULT_LLM_MODEL).toBe('qwen3:4b-instruct-2507-q4_K_M');
    expect(new OllamaProvider().model).toBe(DEFAULT_LLM_MODEL);
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

// ---------------------------------------------------------------------------
// Default model vs the saved setting
// ---------------------------------------------------------------------------
describe('getLlmModel', () => {
  it('falls back to the default when nothing is saved', async () => {
    installChromeMock();
    expect(await getLlmModel()).toBe(DEFAULT_LLM_MODEL);
  });

  it('keeps a model the user saved before the default changed', async () => {
    installChromeMock();
    await saveLlmModel('qwen2.5:3b');
    expect(await getLlmModel()).toBe('qwen2.5:3b');
  });
});

// ---------------------------------------------------------------------------
// thinkSetting — shared with scripts/bakeoff/run.mjs
// ---------------------------------------------------------------------------
describe('thinkSetting', () => {
  it('sends think: false to models with the thinking capability', () => {
    expect(THINKING_CAPABILITY).toBe('thinking');
    expect(thinkSetting({ capabilities: ['completion', 'thinking'] })).toBe(false);
  });

  it('omits think for other models and malformed responses', () => {
    expect(thinkSetting({ capabilities: ['completion'] })).toBeUndefined();
    expect(thinkSetting({ capabilities: 'thinking' })).toBeUndefined();
    expect(thinkSetting({})).toBeUndefined();
    expect(thinkSetting(null)).toBeUndefined();
    expect(thinkSetting(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OllamaProvider — /api/show at session start
// ---------------------------------------------------------------------------
describe('OllamaProvider session', () => {
  /** Answers /api/show with `show` (or `showStatus`) and /api/chat with an empty stream. */
  function stubOllama(show: unknown, showStatus = 200) {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).endsWith('/api/show')
        ? new Response(JSON.stringify(show), { status: showStatus })
        : new Response('{"done":true}\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function chatBody(provider: OllamaProvider, fetchMock: ReturnType<typeof stubOllama>) {
    const stream = await provider.simplifyChunk('Hi');
    for await (const _ of stream) { /* drain */ }
    const chat = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/chat'))!;
    return JSON.parse(String(chat[1]?.body)) as Record<string, unknown>;
  }

  it('sends think: false when the model can think', async () => {
    const fetchMock = stubOllama({ capabilities: ['completion', 'thinking'] });
    const provider = new OllamaProvider();
    await provider.createBaseSession('System');

    const show = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/show'))!;
    expect(JSON.parse(String(show[1]?.body))).toEqual({ model: DEFAULT_LLM_MODEL });
    const body = await chatBody(provider, fetchMock);
    expect(body.think).toBe(false);
    expect(body).not.toHaveProperty('options');
  });

  it('sends no think field when the model cannot think', async () => {
    const fetchMock = stubOllama({ capabilities: ['completion'] });
    const provider = new OllamaProvider('qwen2.5:3b');
    await provider.createBaseSession('System');
    expect(await chatBody(provider, fetchMock)).not.toHaveProperty('think');
  });

  it('rejects with 404 when the model is not pulled', async () => {
    stubOllama({ error: 'model not found' }, 404);
    await expect(new OllamaProvider('nope:1b').createBaseSession('System')).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// missingModelLog — console only
// ---------------------------------------------------------------------------
describe('missingModelLog', () => {
  it('names the pull command for the default model', () => {
    expect(missingModelLog(DEFAULT_LLM_MODEL)).toBe(
      '[Clarity] Model qwen3:4b-instruct-2507-q4_K_M is not installed in Ollama. ' +
      'Run: ollama pull qwen3:4b-instruct-2507-q4_K_M',
    );
  });

  it('adds the default model command when another model is missing', () => {
    const line = missingModelLog('llama3.2:1b');
    expect(line).toContain('Run: ollama pull llama3.2:1b');
    expect(line).toContain('ollama pull qwen3:4b-instruct-2507-q4_K_M');
  });
});
