import { Readable } from "node:stream";
import { MODEL_RELAY_ERROR_CODES, modelRelayError } from "./errors.ts";

/**
 * Byte-level JSON model-field rewriting.
 *
 * The relay must not re-serialize payloads: multi-megabyte prompt strings,
 * tool payloads and SSE events cross the relay byte-for-byte except for the
 * declared model fields. The scanner keeps O(1) state, streams untouched
 * bytes immediately and only buffers the string it may replace.
 *
 * The scanner is hand-rolled on purpose. Maintained streaming parsers were
 * evaluated and rejected on this boundary: `@streamparser/json` normalizes
 * numbers and escapes and its offsets cannot address raw bytes, `stream-json`
 * is an object stream that likewise drops the original bytes, and `jsonparse`
 * has been unmaintained since 2022. The byte-for-byte passthrough promise
 * needs token-accurate offsets, which none of them expose.
 */

export type JsonModelPath = readonly string[];

export type JsonModelRewriteMapping = {
  /** Paths from the document root whose string values carry the model name. */
  paths: readonly JsonModelPath[];
  /** Replacement for values equal to `expectedUpstreamName`. */
  externalName?: string;
  /** Upstream model name the relay requested for this operation. */
  expectedUpstreamName?: string;
  /** Called once when an actual model value differs from the requested one. */
  onMismatch?: () => void;
};

const DEFAULT_MAX_STRING_BYTES = 1024;
const DEFAULT_MAX_KEY_BYTES = 1024;

function isWhitespace(byte: number) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function utf8Bytes(codePoint: number): Buffer {
  const bytes: number[] = [];
  if (codePoint <= 0x7f) bytes.push(codePoint);
  else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
  else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  else bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  return Buffer.from(bytes);
}

function readHexUnit(raw: Buffer, index: number) {
  if (index + 4 > raw.length - 1) return undefined;
  const hex = raw.subarray(index, index + 4).toString("ascii");
  return /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : undefined;
}

/** Decode a raw quoted JSON string, including UTF-8 content and escapes. */
export function decodeJsonString(raw: Buffer): string | undefined {
  if (raw.length < 2 || raw[0] !== 0x22 || raw[raw.length - 1] !== 0x22) return undefined;
  const end = raw.length - 1;
  const parts: (Buffer | string)[] = [];
  let runStart = 1;
  let index = 1;
  while (index < end) {
    if (raw[index] !== 0x5c) {
      index += 1;
      continue;
    }
    if (index > runStart) parts.push(raw.subarray(runStart, index));
    index += 1;
    if (index >= end) return undefined;
    const escape = raw[index];
    const simple: Record<number, string> = { 0x22: '"', 0x5c: "\\", 0x2f: "/", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t" };
    if (simple[escape] !== undefined) {
      parts.push(simple[escape]);
      index += 1;
      runStart = index;
      continue;
    }
    if (escape !== 0x75) return undefined;
    const unit = readHexUnit(raw, index + 1);
    if (unit === undefined) return undefined;
    index += 5;
    if (unit >= 0xd800 && unit <= 0xdbff && index + 6 <= end && raw[index] === 0x5c && raw[index + 1] === 0x75) {
      const low = readHexUnit(raw, index + 2);
      if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
        parts.push(utf8Bytes(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)));
        index += 6;
        runStart = index;
        continue;
      }
    }
    parts.push(utf8Bytes(unit));
    runStart = index;
  }
  if (index > runStart) parts.push(raw.subarray(runStart, index));
  return Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "utf8") : part))).toString("utf8");
}

function pathsEqual(path: readonly (string | undefined)[], candidate: JsonModelPath) {
  if (path.length !== candidate.length) return false;
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== candidate[index]) return false;
  }
  return true;
}

export type JsonModelScannerOptions = {
  paths: readonly JsonModelPath[];
  /**
   * Replacement bytes for a matching model value. Throw to fail closed;
   * return undefined to keep the original value.
   */
  onModelValue: (value: string) => Buffer | undefined;
  /** Called for a non-string or oversized value at a model path. */
  onInvalidModelValue?: () => Error;
  /** Throw instead of streaming past the buffer bound (request bodies). */
  failOnOversizedValue?: boolean;
  maxStringBytes?: number;
};

/**
 * Incremental JSON string rewriter. `push` returns the output chunks produced
 * by one input chunk in order; `end` flushes trailing state.
 */
export class JsonModelScanner {
  private readonly paths: readonly JsonModelPath[];
  private readonly onModelValue: (value: string) => Buffer | undefined;
  private readonly onInvalidModelValue?: () => Error;
  private readonly failOnOversizedValue: boolean;
  private readonly maxStringBytes: number;
  private readonly keys: (string | undefined)[] = [];
  private readonly containers: ("object" | "array" | undefined)[] = [];
  private depth = 0;
  private slot: "key" | "value" | "none" = "none";
  private valuePath: (string | undefined)[] = [];
  private inString = false;
  private stringRole: "key" | "value" = "value";
  private stringCandidate = false;
  private stringEscaped = false;
  private stringBytes = 0;
  private stringParts: Buffer[] = [];
  private stringStart = -1;
  private stringDiscarded = false;
  private matchedValue = false;

  constructor(options: JsonModelScannerOptions) {
    this.paths = options.paths;
    this.onModelValue = options.onModelValue;
    this.onInvalidModelValue = options.onInvalidModelValue;
    this.failOnOversizedValue = options.failOnOversizedValue ?? false;
    this.maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  }

  get matched() {
    return this.matchedValue;
  }

  push(chunk: Buffer): Buffer[] {
    return this.scan(chunk, false).output;
  }

  /**
   * Scan until the first matching model value completes. `consumed` bytes of
   * the chunk belong to the parsed prefix; the caller replays the remainder
   * through `push` so a later duplicate model field still fails closed.
   */
  pushUntilMatch(chunk: Buffer): { output: Buffer[]; consumed: number } {
    return this.scan(chunk, true);
  }

  private scan(chunk: Buffer, stopAfterMatch: boolean): { output: Buffer[]; consumed: number } {
    const output: Buffer[] = [];
    let passFrom = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];
      if (this.inString) {
        if (this.stringEscaped) this.stringEscaped = false;
        else if (byte === 0x5c) this.stringEscaped = true;
        else if (byte === 0x22) {
          this.finishString(chunk, index + 1, output);
          passFrom = index + 1;
          if (stopAfterMatch && this.matchedValue) return { output, consumed: index + 1 };
        }
        continue;
      }
      if (byte === 0x22) {
        if (index > passFrom) output.push(chunk.subarray(passFrom, index));
        this.startString(index);
        passFrom = index;
        continue;
      }
      if (this.slot === "value" && this.isModelPath() && this.onInvalidModelValue && !isWhitespace(byte)) {
        throw this.onInvalidModelValue();
      }
      if (byte === 0x7b) {
        this.depth += 1;
        this.containers[this.depth - 1] = "object";
        this.keys.length = this.depth;
        this.keys[this.depth - 1] = undefined;
        this.valuePath = [];
        this.slot = "key";
      } else if (byte === 0x5b) {
        this.depth += 1;
        this.containers[this.depth - 1] = "array";
        this.keys.length = this.depth;
        this.keys[this.depth - 1] = undefined;
        this.valuePath = [];
        this.slot = "value";
      } else if (byte === 0x7d || byte === 0x5d) {
        if (this.depth > 0) this.depth -= 1;
        this.containers.length = this.depth;
        this.keys.length = this.depth;
        this.valuePath = [];
        this.slot = "none";
      } else if (byte === 0x2c) {
        this.slot = this.containers[this.depth - 1] === "object" ? "key" : "value";
      } else if (byte === 0x3a) {
        this.valuePath = [...this.keys.slice(0, this.depth - 1), this.keys[this.depth - 1]];
        this.slot = "value";
      } else if (!isWhitespace(byte) && this.slot === "value") {
        // Primitive value (number/literal); its delimiter resets the slot.
        this.slot = "none";
      }
      if (stopAfterMatch && this.matchedValue) return { output, consumed: index + 1 };
    }
    if (this.inString) {
      this.appendStringPart(chunk.subarray(this.stringStart >= 0 ? this.stringStart : 0), output);
      this.stringStart = -1;
      passFrom = chunk.length;
    }
    if (passFrom < chunk.length) output.push(chunk.subarray(passFrom));
    return { output, consumed: chunk.length };
  }

  end(): Buffer[] {
    const output = [...this.stringParts];
    this.stringParts = [];
    return output;
  }

  private isModelPath() {
    return this.paths.some((path) => pathsEqual(this.valuePath, path));
  }

  private startString(index: number) {
    this.inString = true;
    this.stringEscaped = false;
    this.stringBytes = 0;
    this.stringParts = [];
    this.stringDiscarded = false;
    this.stringRole = this.slot === "key" && this.containers[this.depth - 1] === "object" ? "key" : "value";
    this.stringCandidate = this.stringRole === "value" && this.isModelPath();
    this.stringStart = index;
  }

  private appendStringPart(part: Buffer, output: Buffer[]) {
    if (!part.length) return;
    if (this.stringDiscarded || (this.stringRole !== "key" && !this.stringCandidate)) {
      output.push(part);
      return;
    }
    this.stringParts.push(part);
    this.stringBytes += part.length;
    const limit = this.stringRole === "key" ? DEFAULT_MAX_KEY_BYTES : this.maxStringBytes;
    if (this.stringBytes <= limit) return;
    if (this.stringRole === "value" && this.failOnOversizedValue && this.onInvalidModelValue) {
      throw this.onInvalidModelValue();
    }
    this.stringDiscarded = true;
    output.push(...this.stringParts);
    this.stringParts = [];
  }

  private finishString(chunk: Buffer, end: number, output: Buffer[]) {
    this.appendStringPart(chunk.subarray(this.stringStart >= 0 ? this.stringStart : 0, end), output);
    this.stringStart = -1;
    const raw = this.stringParts.length ? Buffer.concat(this.stringParts) : undefined;
    this.stringParts = [];
    this.inString = false;
    const role = this.stringRole;
    const candidate = this.stringCandidate;
    this.stringRole = "value";
    this.stringCandidate = false;
    if (role === "key") {
      this.keys[this.depth - 1] = raw ? decodeJsonString(raw) : undefined;
      if (raw) output.push(raw);
      this.slot = "none";
      return;
    }
    this.slot = "none";
    if (!candidate || !raw) {
      if (raw) output.push(raw);
      return;
    }
    const decoded = decodeJsonString(raw);
    if (decoded === undefined) {
      if (this.onInvalidModelValue) throw this.onInvalidModelValue();
      output.push(raw);
      return;
    }
    this.matchedValue = true;
    output.push(this.onModelValue(decoded) ?? raw);
  }
}

function responseReplacement(mapping: JsonModelRewriteMapping) {
  let mismatched = false;
  return (value: string): Buffer | undefined => {
    if (mapping.expectedUpstreamName === undefined || mapping.externalName === undefined) return undefined;
    if (value === mapping.expectedUpstreamName) return Buffer.from(JSON.stringify(mapping.externalName), "utf8");
    if (!mismatched) {
      mismatched = true;
      mapping.onMismatch?.();
    }
    return undefined;
  };
}

/** Rewrite one small JSON buffer (for example one SSE data payload). */
export function rewriteJsonModelBuffer(buffer: Buffer, mapping: JsonModelRewriteMapping): Buffer {
  const scanner = new JsonModelScanner({
    paths: mapping.paths,
    onModelValue: responseReplacement(mapping),
  });
  const output = [...scanner.push(buffer), ...scanner.end()];
  if (output.length === 1) return output[0];
  return Buffer.concat(output);
}

/** Stream a JSON response body while rewriting only declared model fields. */
export function rewriteJsonModelResponseBody(body: Readable, mapping: JsonModelRewriteMapping): Readable {
  const scanner = new JsonModelScanner({
    paths: mapping.paths,
    onModelValue: responseReplacement(mapping),
  });
  return Readable.from((async function* () {
    for await (const chunk of body) {
      for (const part of scanner.push(toBuffer(chunk))) yield part;
    }
    for (const part of scanner.end()) yield part;
  })(), { objectMode: false });
}

export type ModelRelayRequestBody = {
  body: Readable;
  externalModelName: string;
  upstreamModelName: string;
};

/**
 * Resolve the request's top-level model before any upstream contact, then
 * replay the buffered prefix followed by the still-streaming remainder. A
 * second model field later in the body fails closed by aborting the body.
 */
export async function createModelRelayRequestBody(input: {
  body: Readable;
  resolveUpstreamModelName: (externalName: string) => string;
  maxPrologueBytes: number;
  maxStringBytes?: number;
  paths?: readonly JsonModelPath[];
}): Promise<ModelRelayRequestBody> {
  let externalModelName: string | undefined;
  let upstreamModelName: string | undefined;
  const scanner = new JsonModelScanner({
    paths: input.paths ?? [["model"]],
    maxStringBytes: input.maxStringBytes,
    failOnOversizedValue: true,
    onInvalidModelValue: () => modelRelayError(
      400,
      MODEL_RELAY_ERROR_CODES.invalidRequestModel,
      "The relay request must contain exactly one top-level string model field.",
    ),
    onModelValue: (value) => {
      if (externalModelName !== undefined) {
        throw modelRelayError(400, MODEL_RELAY_ERROR_CODES.ambiguousModelName, "The relay request contains more than one model field.");
      }
      const resolved = input.resolveUpstreamModelName(value);
      externalModelName = value;
      upstreamModelName = resolved;
      return Buffer.from(JSON.stringify(resolved), "utf8");
    },
  });
  const held: Buffer[] = [];
  let heldBytes = 0;
  const hold = (parts: Buffer[]) => {
    for (const part of parts) {
      heldBytes += part.length;
      if (heldBytes > input.maxPrologueBytes) {
        throw modelRelayError(413, MODEL_RELAY_ERROR_CODES.requestTooLarge, "The relay request model field was not found within the configured limit.");
      }
      held.push(part);
    }
  };
  // Iterate the source manually: breaking out of `for await` would destroy the
  // request stream, but the remainder still has to reach the upstream.
  const iterator = chunksOf(input.body);
  let remainder: Buffer | undefined;
  while (externalModelName === undefined) {
    const next = await iterator.next();
    if (next.done) break;
    const scanned = scanner.pushUntilMatch(next.value);
    hold(scanned.output);
    if (externalModelName !== undefined) remainder = next.value.subarray(scanned.consumed);
  }
  if (externalModelName === undefined || upstreamModelName === undefined) {
    void iterator.return?.(undefined);
    throw modelRelayError(400, MODEL_RELAY_ERROR_CODES.invalidRequestModel, "The relay request does not contain a top-level model field.");
  }
  const body = Readable.from((async function* () {
    let finished = false;
    try {
      for (const part of held) yield part;
      if (remainder?.length) {
        for (const part of scanner.push(remainder)) yield part;
      }
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        for (const part of scanner.push(next.value)) yield part;
      }
      for (const part of scanner.end()) yield part;
    } finally {
      if (!finished) await iterator.return?.(undefined);
    }
  })(), { objectMode: false });
  return { body, externalModelName, upstreamModelName };
}

async function* chunksOf(body: Readable): AsyncGenerator<Buffer> {
  for await (const chunk of body) yield toBuffer(chunk);
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.from(chunk as Uint8Array);
}
