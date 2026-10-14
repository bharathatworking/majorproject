import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseOllamaStream } from '../../src/lib/llm/ollama-stream';

async function* fromChunks(chunks: Array<Uint8Array | string>) {
  for (const c of chunks) yield c;
}

async function collect(chunks: Array<Uint8Array | string>): Promise<string[]> {
  const out: string[] = [];
  for await (const delta of parseOllamaStream(fromChunks(chunks))) out.push(delta);
  return out;
}

const line = (content: string, done = false) =>
  JSON.stringify({ message: { role: 'assistant', content }, done }) + '\n';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// parseOllamaStream — NDJSON from /api/chat
// ---------------------------------------------------------------------------
describe('parseOllamaStream', () => {
  it('yields message content deltas in order', async () => {
    expect(await collect([line('Hello'), line(' world'), line('', true)])).toEqual(['Hello', ' world']);
  });

  it('reassembles a JSON line split across chunks', async () => {
    const full = line('split') + line('', true);
    const chunks = [full.slice(0, 7), full.slice(7, 20), full.slice(20)];
    expect(await collect(chunks)).toEqual(['split']);
  });

  it('decodes a multibyte character split across byte chunks', async () => {
    const bytes = new TextEncoder().encode(line('café') + line('', true));
    const cut = bytes.indexOf(0xc3) + 1;   // between the two bytes of "é"
    expect(await collect([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(['café']);
  });

  it('parses a final line that has no trailing newline', async () => {
    expect(await collect([line('a'), line('b').trimEnd()])).toEqual(['a', 'b']);
  });

  it('skips malformed lines with a [Clarity] warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await collect([line('a'), '{"message": {"content": "b"\n', '42\n', line('c'), line('', true)]);
    expect(result).toEqual(['a', 'c']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('[Clarity]');
  });

  it('throws an Error carrying the message of an error line', async () => {
    await expect(collect([line('partial'), '{"error":"model not found"}\n'])).rejects.toThrow('model not found');
  });

  it('stops at done: true and ignores anything after it', async () => {
    expect(await collect([line('a'), line('', true), line('after'), '{"error":"late"}\n'])).toEqual(['a']);
  });

  it('skips blank lines', async () => {
    expect(await collect(['\n', line('a'), '\n\n', line('', true)])).toEqual(['a']);
  });
});
