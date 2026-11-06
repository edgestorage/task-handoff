import assert from "node:assert/strict";
import test from "node:test";
import { normalizeControlledInstanceCapabilities, supportsRepositoryFileContent, supportsRepositoryPathSearch } from "../src/control-plane.ts";

test("v0.0.49 capability documents keep basic repository access when raw content is absent", () => {
  const previous = { features: { repositoryPathSearch: true } };
  assert.equal(supportsRepositoryFileContent(previous), false);
  assert.equal(supportsRepositoryPathSearch(previous), true);
  assert.equal(normalizeControlledInstanceCapabilities(previous).features.repositoryFileContent, false);
});

test("raw-file capability is additive and does not coerce malformed or future values", () => {
  assert.equal(supportsRepositoryFileContent({ features: { repositoryFileContent: true, futureFeature: true }, future: {} }), true);
  for (const value of [undefined, null, "true", 1, false]) {
    assert.equal(supportsRepositoryFileContent({ features: { repositoryFileContent: value } }), false);
  }
});
