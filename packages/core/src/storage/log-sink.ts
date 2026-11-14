import { Writable } from "node:stream";

export const DEFAULT_LOG_RING_BUFFER_BYTES = 64 * 1024;

export type LogDestinationStream = NodeJS.WritableStream & {
  destroyed?: boolean;
};

type LogStreamErrorListener = (error: unknown) => void;

const installedErrorHandlers = new WeakSet<object>();
const unavailableStreams = new WeakSet<object>();
const streamErrorListeners = new WeakMap<object, Set<LogStreamErrorListener>>();

function streamKey(stream: LogDestinationStream | undefined | null): object | undefined {
  return stream && (typeof stream === "object" || typeof stream === "function") ? stream : undefined;
}

export function markLogStreamUnavailable(stream: LogDestinationStream | undefined | null) {
  const key = streamKey(stream);
  if (key) unavailableStreams.add(key);
}

export function isLogStreamUnavailable(stream: LogDestinationStream | undefined | null) {
  const key = streamKey(stream);
  return key ? unavailableStreams.has(key) : false;
}

function ensureLogStreamErrorHandler(stream: LogDestinationStream) {
  const key = streamKey(stream);
  if (!key || installedErrorHandlers.has(key) || typeof stream.on !== "function") return;
  installedErrorHandlers.add(key);
  stream.on("error", (error: unknown) => {
    markLogStreamUnavailable(stream);
    const listeners = streamErrorListeners.get(key);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(error);
      } catch {
        // A log-sink error observer must never take down the process.
      }
    }
  });
}

export function onLogStreamError(stream: LogDestinationStream, listener: LogStreamErrorListener) {
  const key = streamKey(stream);
  if (!key) return () => undefined;
  ensureLogStreamErrorHandler(stream);
  let listeners = streamErrorListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    streamErrorListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) streamErrorListeners.delete(key);
  };
}

export function installLogStreamErrorHandlers(streams: readonly LogDestinationStream[] = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (stream) ensureLogStreamErrorHandler(stream);
  }
}

export class LogRingBuffer {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  readonly capacityBytes: number;

  constructor(capacityBytes = DEFAULT_LOG_RING_BUFFER_BYTES) {
    this.capacityBytes = capacityBytes;
  }

  append(value: string | Buffer) {
    if (this.capacityBytes <= 0) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.capacityBytes) {
      this.chunks = [chunk.subarray(chunk.byteLength - this.capacityBytes)];
      this.bufferedBytes = this.chunks[0].byteLength;
      return;
    }
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    while (this.bufferedBytes > this.capacityBytes) {
      const first = this.chunks[0];
      const overflow = this.bufferedBytes - this.capacityBytes;
      if (first.byteLength <= overflow) {
        this.chunks.shift();
        this.bufferedBytes -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.bufferedBytes -= overflow;
      }
    }
  }

  get size() {
    return this.bufferedBytes;
  }

  read() {
    return Buffer.concat(this.chunks, this.bufferedBytes);
  }

  text() {
    return this.read().toString("utf8");
  }

  clear() {
    this.chunks = [];
    this.bufferedBytes = 0;
  }
}

export type SafeLogWritableOptions = {
  maxBufferedBytes?: number;
  writeTimeoutMs?: number;
  onFailure?: (error: unknown) => void;
};

function canWrite(stream: LogDestinationStream | undefined | null) {
  return Boolean(stream && typeof stream.write === "function" && !stream.destroyed && stream.writable !== false);
}

/**
 * Terminal log writes are best-effort. Once the destination fails (ENOSPC/EPIPE or
 * any other I/O error), stop forwarding to it and keep a small in-memory tail for
 * diagnostics. This writable never reports write errors upstream.
 */
export class SafeLogWritable extends Writable {
  readonly buffer: LogRingBuffer;
  private failed = false;
  private pendingChunk?: Buffer;
  private pendingFinish?: () => void;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private readonly upstream: LogDestinationStream;
  private readonly options: SafeLogWritableOptions;
  private readonly unsubscribe?: () => void;

  constructor(upstream: LogDestinationStream, options: SafeLogWritableOptions = {}) {
    super();
    this.upstream = upstream;
    this.options = options;
    this.buffer = new LogRingBuffer(options.maxBufferedBytes);
    // The sink itself is the final destination for Pino; no error may escape it.
    this.on("error", () => undefined);
    if (upstream && typeof upstream.on === "function") {
      this.unsubscribe = onLogStreamError(upstream, (error) => {
        this.fail(error, this.pendingChunk);
      });
    }
  }

  get unavailable() {
    return this.failed || isLogStreamUnavailable(this.upstream) || !canWrite(this.upstream);
  }

  readBufferedLogs() {
    return this.buffer.text();
  }

  private fail(error: unknown, chunk?: Buffer) {
    if (this.failed) return;
    this.failed = true;
    markLogStreamUnavailable(this.upstream);
    if (chunk?.byteLength) this.buffer.append(chunk);
    this.pendingChunk = undefined;
    const finish = this.pendingFinish;
    this.pendingFinish = undefined;
    try {
      this.options.onFailure?.(error);
    } catch {
      // Failure diagnostics are best-effort too.
    }
    finish?.();
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    let bytes: Buffer;
    try {
      bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    } catch {
      bytes = Buffer.from(String(chunk));
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = undefined;
      }
      if (this.pendingFinish === finish) this.pendingFinish = undefined;
      try {
        callback();
      } catch {
        // The stream callback belongs to Node internals; a logging failure must not escape it.
      }
    };

    if (this.failed || isLogStreamUnavailable(this.upstream) || !canWrite(this.upstream)) {
      this.failed = true;
      this.buffer.append(bytes);
      finish();
      return;
    }

    this.pendingChunk = bytes;
    this.pendingFinish = finish;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.fail(new Error("Log destination write timed out."), bytes);
    }, this.options.writeTimeoutMs ?? 5_000);
    this.pendingTimer.unref?.();
    try {
      this.upstream.write(bytes, (error?: Error | null) => {
        if (error) {
          this.fail(error, bytes);
          return;
        }
        if (this.pendingChunk === bytes) this.pendingChunk = undefined;
        finish();
      });
    } catch (error) {
      this.fail(error, bytes);
    }
  }

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void) {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    try {
      this.unsubscribe?.();
    } catch {
      // Ignore listener cleanup failures.
    }
    callback();
  }
}

export function createSafeLogWritable(upstream: LogDestinationStream = process.stdout, options: SafeLogWritableOptions = {}) {
  return new SafeLogWritable(upstream, options);
}

/**
 * Route Pino/Fastify's default stdout destination through the safe writable while
 * preserving explicitly configured streams, files, transports, or logger: false.
 */
export function withSafeLogDestination(logger: boolean | object | undefined): boolean | Record<string, unknown> {
  if (logger === false) return false;
  if (logger === undefined || logger === true) return { stream: createSafeLogWritable(process.stdout) };
  const configured = logger as Record<string, unknown>;
  if ("stream" in configured) {
    const stream = configured.stream;
    if (!stream || stream === process.stdout || stream === process.stderr) {
      return { ...configured, stream: createSafeLogWritable(stream === process.stderr ? process.stderr : process.stdout) };
    }
    return configured;
  }
  if (configured.file || configured.transport) return configured;
  return { ...configured, stream: createSafeLogWritable(process.stdout) };
}
