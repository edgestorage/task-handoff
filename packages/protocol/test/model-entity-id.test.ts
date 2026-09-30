import assert from "node:assert/strict";
import test from "node:test";

import {
  createEntityId,
  createModelEntityId,
  isModelConfigHashId,
  modelConfigHash,
} from "../src/control-plane.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const PAYLOAD = "[0-9abcdefghjkmnpqrstvwxyz]{13}";

test("new model entity ids are short time-ordered base32 identities", () => {
  const early = createModelEntityId(EPOCH + 1_000);
  const late = createModelEntityId(EPOCH + 2_000);
  for (const id of [early, late]) {
    assert.match(id, new RegExp(`^mdl_${PAYLOAD}$`));
  }
  // Encoding the whole 64-bit snowflake at a fixed width keeps the millisecond
  // prefix in the high symbols, so ids minted later sort after minted earlier.
  assert.ok(early < late, `${early} should sort before ${late}`);
});

test("ids minted within one millisecond stay distinct for any entity prefix", () => {
  const ids = new Set(Array.from({ length: 4_096 }, () => createEntityId("inst", EPOCH + 5_000)));
  assert.equal(ids.size, 4_096);
  for (const id of ids) assert.match(id, new RegExp(`^inst_${PAYLOAD}$`));
});

test("entity id payloads are fixed-width Crockford base32 without '=' padding", () => {
  for (const now of [EPOCH + 1, EPOCH + 1_000, Date.UTC(2030, 0, 1)]) {
    const payload = createEntityId("inst", now).slice("inst_".length);
    assert.equal(payload.length, 13);
    assert.doesNotMatch(payload, /[=]/, `payload ${payload} must not carry base32 padding`);
    assert.equal(payload, payload.toLowerCase());
  }
});

test("the shared minter keeps the caller's domain prefix", () => {
  assert.match(createEntityId("mdl", EPOCH + 6_000), new RegExp(`^mdl_${PAYLOAD}$`));
  assert.match(createEntityId("story", EPOCH + 6_000), new RegExp(`^story_${PAYLOAD}$`));
});

test("legacy content-hash projections stay distinguishable from minted identities", () => {
  const hash = modelConfigHash({ app: "codex", endpoint: "https://api.example.test/v1", key: "secret", model: "gpt-test" });
  assert.equal(isModelConfigHashId(hash), true);
  assert.equal(isModelConfigHashId(createModelEntityId()), false);
  assert.equal(isModelConfigHashId(`mdl_${"0".repeat(64)}`), true);
  assert.equal(isModelConfigHashId(`mdl_${"z".repeat(64)}`), false);
  assert.equal(isModelConfigHashId("mdl_short"), false);
});
