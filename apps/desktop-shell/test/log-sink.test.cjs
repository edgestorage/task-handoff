const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const test = require("node:test");
const { markLogStreamUnavailable, writeLogLine } = require("../src/log-sink.cjs");

function brokenStream(code, onWrite = () => undefined) {
  return {
    destroyed: false,
    writable: true,
    write() {
      onWrite();
      throw Object.assign(new Error("log sink unavailable"), { code });
    },
  };
}

test("desktop log sinks never throw and stop writing after an unavailable stream", () => {
  let writes = 0;
  const stream = brokenStream("EIO", () => { writes += 1; });

  assert.doesNotThrow(() => writeLogLine(stream, "first"));
  assert.doesNotThrow(() => writeLogLine(stream, "second"));
  assert.equal(writes, 1);
});

test("desktop log sinks mark asynchronous stream failures as unavailable", async () => {
  let writes = 0;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback(Object.assign(new Error("log sink unavailable"), { code: "EIO" }));
    },
  });
  stream.on("error", () => undefined);

  writeLogLine(stream, "first");
  await new Promise((resolve) => setImmediate(resolve));
  writeLogLine(stream, "second");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes, 1);
});

test("desktop log sinks skip streams already reported unavailable", () => {
  const stream = brokenStream("EIO");
  markLogStreamUnavailable(stream);

  assert.doesNotThrow(() => writeLogLine(stream, "skipped"));
});
