import { Readable } from "node:stream";
import { MODEL_RELAY_ERROR_CODES, modelRelayError } from "./errors.ts";
import { rewriteJsonModelBuffer, type JsonModelRewriteMapping } from "./json-model-rewrite.ts";

/**
 * SSE line framer that preserves the original event bytes and only rewrites
 * JSON `data:` payloads through the byte-level model scanner. Non-data lines
 * (`event:`, `id:`, comments, custom fields) are emitted verbatim; a data
 * payload is only replaced when the scanner actually matched a model field.
 *
 * The framer is hand-rolled on purpose: `eventsource-parser` normalizes an
 * event into a JS object and drops the raw lines, while the relay promises
 * byte-for-byte passthrough of everything it does not rewrite. See
 * `json-model-rewrite.ts` for the same trade-off on the JSON side.
 */

type SseLine = { raw: Buffer; content: Buffer; terminator: Buffer };

async function* sseLines(source: AsyncIterable<Buffer | string>): AsyncGenerator<SseLine> {
  let carry = Buffer.alloc(0);
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const data = carry.length ? Buffer.concat([carry, buffer]) : buffer;
    let lineStart = 0;
    let index = 0;
    while (index < data.length) {
      const byte = data[index];
      if (byte === 0x0a) {
        yield splitLine(data, lineStart, index + 1);
        lineStart = index + 1;
      } else if (byte === 0x0d) {
        if (index + 1 >= data.length) break;
        const end = data[index + 1] === 0x0a ? index + 2 : index + 1;
        yield splitLine(data, lineStart, end);
        lineStart = end;
        index = end - 1;
      }
      index += 1;
    }
    carry = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : Buffer.alloc(0);
  }
  if (carry.length) yield splitLine(carry, 0, carry.length);
}

function splitLine(buffer: Buffer, start: number, end: number): SseLine {
  const raw = buffer.subarray(start, end);
  let contentEnd = end;
  if (raw.length && raw[raw.length - 1] === 0x0a) contentEnd -= 1;
  if (contentEnd > start && buffer[contentEnd - 1] === 0x0d) contentEnd -= 1;
  return {
    raw: Buffer.from(raw),
    content: Buffer.from(buffer.subarray(start, contentEnd)),
    terminator: Buffer.from(buffer.subarray(contentEnd, end)),
  };
}

function dataPayload(content: Buffer) {
  if (content.length < 5 || content.subarray(0, 5).toString("ascii") !== "data:") return undefined;
  let payload = content.subarray(5);
  if (payload.length && payload[0] === 0x20) payload = payload.subarray(1);
  return payload;
}

function looksLikeJson(buffer: Buffer) {
  for (const byte of buffer) {
    if (byte === 0x20 || byte === 0x09) continue;
    return byte === 0x7b;
  }
  return false;
}

function splitOnNewline(buffer: Buffer) {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    parts.push(buffer.subarray(start, index));
    start = index + 1;
  }
  parts.push(buffer.subarray(start));
  return parts;
}

/**
 * Rewrite one event's data payload. Multiple `data:` lines are joined with
 * "\n" (the SSE rule) so a field split across lines is never concatenated by
 * accident. The scanner only swaps a single-line model name, so the rewritten
 * payload keeps the original line count and maps back onto the original
 * `data:` lines; anything else passes through unchanged.
 */
function rewriteSseEventData(payloads: Buffer[], mapping: JsonModelRewriteMapping): Buffer[] | undefined {
  if (!payloads.length) return undefined;
  const joined = payloads.length === 1
    ? payloads[0]
    : Buffer.concat(payloads.flatMap((payload, index) => (index === 0 ? [payload] : [Buffer.from("\n", "utf8"), payload])));
  if (!looksLikeJson(joined)) return undefined;
  const rewritten = rewriteJsonModelBuffer(joined, mapping);
  if (rewritten.equals(joined)) return undefined;
  const parts = splitOnNewline(rewritten);
  return parts.length === payloads.length ? parts : undefined;
}

export function rewriteSseModelResponseBody(
  body: Readable,
  mapping: JsonModelRewriteMapping,
  options: { maxEventBytes: number },
): Readable {
  return Readable.from((async function* () {
    let lines: SseLine[] = [];
    let eventBytes = 0;
    const flush = function* () {
      const payloads: Buffer[] = [];
      const dataLineIndexes: number[] = [];
      lines.forEach((line, index) => {
        const payload = dataPayload(line.content);
        if (payload === undefined) return;
        payloads.push(payload);
        dataLineIndexes.push(index);
      });
      const rewritten = dataLineIndexes.length ? rewriteSseEventData(payloads, mapping) : undefined;
      const replacements = new Map<number, Buffer>();
      if (rewritten) {
        for (const [position, lineIndex] of dataLineIndexes.entries()) {
          const line = lines[lineIndex];
          const prefix = line.content.subarray(0, line.content.length - payloads[position].length);
          replacements.set(lineIndex, Buffer.concat([prefix, rewritten[position], line.terminator]));
        }
      }
      for (const [index, line] of lines.entries()) yield replacements.get(index) ?? line.raw;
    };
    for await (const line of sseLines(body)) {
      eventBytes += line.raw.length;
      if (eventBytes > options.maxEventBytes) {
        throw modelRelayError(502, MODEL_RELAY_ERROR_CODES.upstreamStreamError, "The upstream SSE event exceeded the relay frame limit.");
      }
      if (line.content.length === 0) {
        yield* flush();
        lines = [];
        eventBytes = 0;
        yield line.raw;
        continue;
      }
      lines.push(line);
    }
    yield* flush();
  })(), { objectMode: false });
}
