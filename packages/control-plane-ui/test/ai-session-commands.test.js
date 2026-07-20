import assert from "node:assert/strict";
import test from "node:test";
import {
  commandTokenAt,
  matchingCommands,
  parseAiSessionCommand,
  replaceCommandToken,
} from "../src/components/ai-session/commands.ts";

test("command menu only opens at the beginning of the composer", () => {
  assert.deepEqual(commandTokenAt("/re", 3, "/"), { start: 0, end: 3, query: "re" });
  assert.equal(commandTokenAt("open /re", 8, "/"), undefined);
  assert.equal(commandTokenAt("/rename task", 12, "/"), undefined);
  assert.deepEqual(matchingCommands("re").map((item) => item.name), ["review", "rename"]);
});

test("command selection and parsing honor a custom trigger", () => {
  const command = matchingCommands("ren")[0];
  const replaced = replaceCommandToken("!ren", 4, "!", command);
  assert.deepEqual(replaced, { value: "!rename ", cursor: 8 });
  assert.deepEqual(parseAiSessionCommand("!rename New thread", "!", "codex"), { command: "rename", argument: "New thread" });
  assert.deepEqual(parseAiSessionCommand("!goal", "!", "codex"), { command: "goal" });
  assert.equal(parseAiSessionCommand("Use !goal here", "!", "codex"), undefined);
});

test("command parsing is disabled for non-Codex sessions", () => {
  assert.equal(parseAiSessionCommand("/review", "/", "claude"), undefined);
  assert.equal(parseAiSessionCommand("/goal keep this as a normal message", "/", undefined), undefined);
});
