import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import Fastify from "fastify";
import { createSafeLogWritable } from "@task-handoff/core/storage/log-sink";

test("Fastify/Pino destination failures do not crash the app", async () => {
  let writes = 0;
  const broken = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
    },
  });
  const app = Fastify({ logger: { stream: createSafeLogWritable(broken) } });
  app.get("/", async () => ({ ok: true }));

  const response = await app.inject("/");
  assert.equal(response.statusCode, 200);
  assert.ok(writes >= 1);

  assert.doesNotThrow(() => app.log.info("second line"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);

  await app.close();
});
