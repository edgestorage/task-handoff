import assert from "node:assert/strict";
import test from "node:test";
import {
  mentionTokenAt,
  reconcileMentionBindings,
  referencesForBindings,
  replaceMentionToken,
  sortMentionCandidates,
} from "../src/components/ai-session/mentions.ts";

const docs = { kind: "skill", name: "Docs", path: "/workspace/docs/SKILL.md" };
const plugin = { kind: "plugin", name: "Docs", path: "plugin://docs" };

test("mentionTokenAt recognizes a token at the cursor and rejects embedded triggers", () => {
  assert.deepEqual(mentionTokenAt("ask @doc later", 8, "@"), { start: 4, end: 8, query: "doc" });
  assert.deepEqual(mentionTokenAt("ask @docs", 7, "@"), { start: 4, end: 9, query: "do" });
  assert.equal(mentionTokenAt("mail@example.com", 8, "@"), undefined);
});

test("candidate replacement binds structured references and inserts paths as plain text", () => {
  const structured = replaceMentionToken({ value: "ask @do", cursor: 7, trigger: "@", candidate: docs, bindings: [] });
  assert.equal(structured.value, "ask @Docs ");
  assert.equal(structured.bindings.length, 1);
  assert.deepEqual(referencesForBindings(structured.value, structured.bindings), [docs]);

  const file = replaceMentionToken({
    value: "open @sr now",
    cursor: 8,
    trigger: "@",
    candidate: { kind: "file", name: "server.ts", path: "src/server.ts" },
    bindings: structured.bindings,
  });
  assert.equal(file.value, "open src/server.ts now");
  assert.deepEqual(file.bindings, []);
});

test("bindings follow paste shifts and disappear after token deletion", () => {
  const binding = { id: "one", token: "@Docs", start: 4, end: 9, reference: docs };
  assert.deepEqual(reconcileMentionBindings("prefix ask @Docs", [binding])[0], { ...binding, start: 11, end: 16 });
  assert.deepEqual(reconcileMentionBindings("ask Docs", [binding]), []);
});

test("same display names retain distinct canonical references", () => {
  const bindings = [
    { id: "one", token: "@Docs", start: 0, end: 5, reference: docs },
    { id: "two", token: "@Docs", start: 6, end: 11, reference: plugin },
  ];
  assert.deepEqual(referencesForBindings("@Docs @Docs", bindings), [docs, plugin]);
});

test("candidate ordering follows the popup category order", () => {
  const candidates = [
    { kind: "app", name: "App", path: "app://app" },
    { kind: "file", name: "index.ts", path: "src/index.ts" },
    { kind: "skill", name: "Skill", path: "/workspace/skill/SKILL.md" },
    { kind: "plugin", name: "Plugin", path: "plugin://plugin" },
  ];
  assert.deepEqual(sortMentionCandidates(candidates, "").map((item) => item.kind), ["plugin", "skill", "file", "app"]);
});
