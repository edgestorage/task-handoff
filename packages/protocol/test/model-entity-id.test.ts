import assert from "node:assert/strict";
import test from "node:test";

import {
  createEntityId,
  createModelEntityId,
  isModelEntityId,
  migratedModelEntityId,
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

test("migrated legacy ids become stable entity identities", () => {
  const legacy = `mdl_${"a".repeat(64)}`;
  const migrated = migratedModelEntityId(legacy);
  assert.match(migrated, new RegExp(`^mdl_${PAYLOAD}$`));
  assert.equal(isModelEntityId(migrated), true);
  // The derivation is deterministic so the control plane and every node
  // holding a replica of the same legacy id converge without coordinating.
  assert.equal(migratedModelEntityId(legacy), migrated);
  assert.notEqual(migratedModelEntityId(`mdl_${"b".repeat(64)}`), migrated);
});

test("stable identity detection rejects legacy and malformed ids", () => {
  assert.equal(isModelEntityId(createModelEntityId()), true);
  assert.equal(isModelEntityId(`mdl_${"0".repeat(64)}`), false);
  assert.equal(isModelEntityId(`mdl_${"z".repeat(64)}`), false);
  assert.equal(isModelEntityId("mdl_short"), false);
  assert.equal(isModelEntityId("inst_0j9w2k4m6p8r0"), false);
});
