import assert from "node:assert/strict";
import test from "node:test";

import { syncAiSessionNextInputSuggestionSettings } from "../src/instances/ai-session-next-input-settings.ts";

test("instance suggestion settings converge once per process incarnation and value", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
  const syncKeys = new Map<string, string>();
  const input = {
    instanceId: "ins_1",
    webUrl: "http://127.0.0.1:9000",
    registrationToken: "secret",
    enabled: true,
    processIncarnationId: "incarnation-1",
    syncKeys,
    request: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return { ok: true, status: 200 };
    },
    warn: (data: Record<string, unknown>, message: string) => warnings.push({ data, message }),
  };

  assert.equal(await syncAiSessionNextInputSuggestionSettings(input), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "http://127.0.0.1:9000/api/internal/ai-session-next-input-suggestion-settings");
  assert.equal((requests[0]!.init.headers as Record<string, string>).authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { enabled: true });

  assert.equal(await syncAiSessionNextInputSuggestionSettings(input), true);
  assert.equal(requests.length, 1);

  assert.equal(await syncAiSessionNextInputSuggestionSettings({ ...input, processIncarnationId: "incarnation-2" }), true);
  assert.equal(requests.length, 2);
  assert.equal(warnings.length, 0);
});

test("failed or thrown live sync requests stay uncached and retry", async () => {
  const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
  const syncKeys = new Map<string, string>();
  const base = {
    instanceId: "ins_2",
    webUrl: "http://127.0.0.1:9001",
    registrationToken: "secret",
    enabled: false,
    processIncarnationId: "incarnation-1",
    syncKeys,
    warn: (data: Record<string, unknown>, message: string) => warnings.push({ data, message }),
  };

  let attempts = 0;
  assert.equal(await syncAiSessionNextInputSuggestionSettings({
    ...base,
    request: async () => {
      attempts += 1;
      return { ok: false, status: 409 };
    },
  }), false);
  assert.equal(syncKeys.has("ins_2"), false);
  assert.equal(warnings.at(-1)?.data.statusCode, 409);

  assert.equal(await syncAiSessionNextInputSuggestionSettings({
    ...base,
    request: async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    },
  }), false);
  assert.equal(syncKeys.has("ins_2"), false);
  assert.equal(warnings.at(-1)?.data.error, "ECONNREFUSED");

  assert.equal(await syncAiSessionNextInputSuggestionSettings({
    ...base,
    request: async () => {
      attempts += 1;
      return { ok: true, status: 200 };
    },
  }), true);
  assert.equal(attempts, 3);
  assert.equal(syncKeys.get("ins_2"), "incarnation-1:false:unsupported:unsupported");
});

test("reasoning mode is only sent to instances that declare the additive capability", async () => {
  const requests: Array<{ init: RequestInit }> = [];
  const syncKeys = new Map<string, string>();
  const base = {
    instanceId: "ins_3",
    webUrl: "http://127.0.0.1:9002",
    registrationToken: "secret",
    enabled: true,
    reasoningEffort: "high" as const,
    processIncarnationId: "incarnation-1",
    syncKeys,
    request: async (_url: string, init: RequestInit) => {
      requests.push({ init });
      return { ok: true, status: 200 };
    },
    warn: () => undefined,
  };

  assert.equal(await syncAiSessionNextInputSuggestionSettings(base), true);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { enabled: true });
  assert.equal(syncKeys.get("ins_3"), "incarnation-1:true:unsupported:unsupported");

  assert.equal(await syncAiSessionNextInputSuggestionSettings({ ...base, reasoningEffortSupported: true }), true);
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { enabled: true, reasoningEffort: "high" });
  assert.equal(syncKeys.get("ins_3"), "incarnation-1:true:high:unsupported");

  assert.equal(await syncAiSessionNextInputSuggestionSettings({ ...base, reasoningEffortSupported: true }), true);
  assert.equal(requests.length, 2);

  assert.equal(await syncAiSessionNextInputSuggestionSettings({
    ...base,
    reasoningEffort: "session",
    reasoningEffortSupported: true,
  }), true);
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(String(requests[2]!.init.body)), { enabled: true, reasoningEffort: "session" });
  assert.equal(syncKeys.get("ins_3"), "incarnation-1:true:session:unsupported");
});

test("the default reasoning mode is the explicit none value", async () => {
  const requests: Array<{ init: RequestInit }> = [];
  assert.equal(await syncAiSessionNextInputSuggestionSettings({
    instanceId: "ins_4",
    webUrl: "http://127.0.0.1:9003",
    registrationToken: "secret",
    enabled: true,
    reasoningEffortSupported: true,
    syncKeys: new Map(),
    request: async (_url, init) => {
      requests.push({ init });
      return { ok: true, status: 200 };
    },
    warn: () => undefined,
  }), true);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { enabled: true, reasoningEffort: "none" });
});

test("a custom suggestion model is sent only with capability and null clears it", async () => {
  const requests: Array<{ init: RequestInit }> = [];
  const syncKeys = new Map<string, string>();
  const base = {
    instanceId: "ins_5",
    webUrl: "http://127.0.0.1:9004",
    registrationToken: "secret",
    enabled: true,
    modelSelection: {
      modelEntityId: "mdl_suggestion",
      modelName: "Suggestion",
      modelUpstreamName: "suggestion-upstream",
    },
    processIncarnationId: "incarnation-1",
    syncKeys,
    request: async (_url: string, init: RequestInit) => {
      requests.push({ init });
      return { ok: true, status: 200 };
    },
    warn: () => undefined,
  };

  assert.equal(await syncAiSessionNextInputSuggestionSettings(base), true);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { enabled: true });
  assert.equal(syncKeys.get("ins_5"), "incarnation-1:true:unsupported:unsupported");

  assert.equal(await syncAiSessionNextInputSuggestionSettings({ ...base, modelSelectionSupported: true }), true);
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
    enabled: true,
    modelSelection: base.modelSelection,
  });
  assert.equal(syncKeys.get("ins_5"), "incarnation-1:true:unsupported:mdl_suggestion:suggestion-upstream");

  assert.equal(await syncAiSessionNextInputSuggestionSettings({
    ...base,
    modelSelection: undefined,
    modelSelectionSupported: true,
  }), true);
  assert.deepEqual(JSON.parse(String(requests[2]!.init.body)), { enabled: true, modelSelection: null });
  assert.equal(syncKeys.get("ins_5"), "incarnation-1:true:unsupported:session");
});
