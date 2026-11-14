import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  LogRingBuffer,
  SafeLogWritable,
  createSafeLogWritable,
  installLogStreamErrorHandlers,
  isLogStreamUnavailable,
  withSafeLogDestination,
  type LogDestinationStream,
} from "../src/storage/log-sink.ts";

class FakeLogStream extends EventEmitter {
  destroyed = false;
  writable = true;
  writes = 0;
  last?: string;
  private readonly writeImpl: (callback?: (error?: Error | null) => void) => void;

  constructor(writeImpl: (callback?: (error?: Error | null) => void) => void = (callback) => callback?.()) {
    super();
    this.writeImpl = writeImpl;
  }

  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void) {
    this.writes += 1;
    this.last = String(chunk);
    this.writeImpl(callback);
    return true;
  }
}

function asDestination(stream: FakeLogStream) {
  return stream as unknown as LogDestinationStream;
}

test("safe log sink catches synchronous write failures and buffers subsequent lines", () => {
  const upstream = new FakeLogStream(() => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });
  const sink = createSafeLogWritable(asDestination(upstream), { maxBufferedBytes: 1024 });

  assert.doesNotThrow(() => sink.write("first\n"));
  assert.doesNotThrow(() => sink.write("second\n"));

  assert.equal(upstream.writes, 1);
  assert.equal(sink.readBufferedLogs(), "first\nsecond\n");
  assert.equal(sink.unavailable, true);
});

test("safe log sink catches asynchronous write failures without emitting an unhandled error", async () => {
  const upstream = new FakeLogStream((callback) => {
    setImmediate(() => callback?.(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  });
  const sink = createSafeLogWritable(asDestination(upstream));

  sink.write("first\n");
  await new Promise((resolve) => setImmediate(resolve));
  sink.write("second\n");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(upstream.writes, 1);
  assert.equal(sink.readBufferedLogs(), "first\nsecond\n");
});

test("safe log sink serializes upstream writes and keeps every failed chunk in order", async () => {
  const upstream = new FakeLogStream((callback) => {
    setImmediate(() => callback?.(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })));
  });
  const sink = createSafeLogWritable(asDestination(upstream), { maxBufferedBytes: 1024 });

  sink.write("A\n");
  sink.write("B\n");

  assert.equal(upstream.writes, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(upstream.writes, 1);
  assert.equal(sink.readBufferedLogs(), "A\nB\n");
  assert.equal(sink.unavailable, true);
});

test("safe log sink handles upstream error events and stops forwarding immediately", () => {
  const upstream = new FakeLogStream();
  const sink = createSafeLogWritable(asDestination(upstream));

  assert.doesNotThrow(() => upstream.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  sink.write("after failure\n");

  assert.equal(upstream.writes, 0);
  assert.equal(sink.unavailable, true);
  assert.equal(sink.readBufferedLogs(), "after failure\n");
});

test("process stream error handlers are installed once per stream", () => {
  const upstream = new FakeLogStream();
  installLogStreamErrorHandlers([asDestination(upstream)]);
  installLogStreamErrorHandlers([asDestination(upstream)]);

  assert.equal(upstream.listenerCount("error"), 1);
  assert.doesNotThrow(() => upstream.emit("error", new Error("disk full")));
  assert.equal(isLogStreamUnavailable(asDestination(upstream)), true);
});

test("log ring buffer keeps only the most recent bytes", () => {
  const buffer = new LogRingBuffer(10);
  buffer.append("123456");
  buffer.append("7890");
  assert.equal(buffer.text(), "1234567890");

  buffer.append("abc");
  assert.equal(buffer.size, 10);
  assert.equal(buffer.text(), "4567890abc");

  buffer.append("0123456789ABC");
  assert.equal(buffer.size, 10);
  assert.equal(buffer.text(), "3456789ABC");
});

test("safe logger destination preserves explicit logger configuration", () => {
  const customStream = new FakeLogStream();
  const configured = { level: "debug", stream: asDestination(customStream) };
  assert.equal(withSafeLogDestination(configured), configured);

  const fileLogger = { file: "/tmp/task-handoff.log" };
  assert.equal(withSafeLogDestination(fileLogger), fileLogger);
  assert.equal(withSafeLogDestination(false), false);

  const safeDefault = withSafeLogDestination({ level: "debug" }) as { level: string; stream: SafeLogWritable };
  assert.equal(safeDefault.level, "debug");
  assert.ok(safeDefault.stream instanceof SafeLogWritable);
});
