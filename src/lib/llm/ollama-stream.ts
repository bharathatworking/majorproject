/**
 * Parser for Ollama's /api/chat streaming response (newline-delimited JSON).
 *
 * Kept pure (no fetch, no chrome.*) so it can be unit-tested with synthetic
 * chunk sequences. Design decisions:
 *
 *   - Network chunks don't align with lines: a JSON object (or a multibyte
 *     UTF-8 character) can be split across chunks, so bytes are decoded in
 *     streaming mode and only complete lines are parsed. A final line without
 *     a trailing newline is still parsed when the input ends.
 *   - A malformed line is skipped with a warning rather than aborting the
 *     whole node — one corrupt line shouldn't discard the rest of the output.
 *   - An `{"error": "..."}` line is a model-side failure (e.g. out of memory
 *     mid-generation) and is thrown so the run loop marks the node as failed.
 *   - `done: true` ends the stream; anything after it is ignored.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** The subset of an /api/chat stream line that Clarity reads. */
interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

/** Result of handling one line: text to yield, or a signal to stop. */
type LineResult = { content?: string; done: boolean };

// ─── Line handling ────────────────────────────────────────────────────────────

function handleLine(line: string): LineResult {
  if (!line.trim()) return { done: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.warn('[Clarity] Skipping malformed Ollama stream line:', line);
    return { done: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('[Clarity] Skipping malformed Ollama stream line:', line);
    return { done: false };
  }

  const chunk = parsed as OllamaChatChunk;
  if (typeof chunk.error === 'string') throw new Error(chunk.error);

  // Ollama's stream yields deltas in message.content — the caller accumulates.
  const content = typeof chunk.message?.content === 'string' && chunk.message.content
    ? chunk.message.content
    : undefined;
  return { content, done: chunk.done === true };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Turns raw stream chunks into content deltas.
 * Throws on an `error` line; returns after the `done: true` line.
 */
export async function* parseOllamaStream(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const { content, done } = handleLine(line);
      if (content) yield content;
      if (done) return;
    }
  }

  // Flush any bytes held back by the streaming decoder, then the last line.
  buffer += decoder.decode();
  const { content } = handleLine(buffer);
  if (content) yield content;
}
