import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  aiSessionStatusLabel,
  displayAiSessionMessage,
  displayAiSessionResponse,
  displayAiSessionTitle,
} from "../src/apps/control-plane/useInstanceSessions.ts";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";
import { AI_SESSION_ATTACHMENT_ONLY_MESSAGE, aiSessionMessageText } from "../src/apps/control-plane/useAiSessionDraft.ts";

const english = createControlPlaneI18nForTest("en-US").global.t;
const chinese = createControlPlaneI18nForTest("zh-CN").global.t;
const raw = "RAW {sessions.status.running} 中文 /workspace/demo";

test("AI prompts and responses remain byte-for-byte identical in both locales", () => {
  const session = {
    id: "ai_raw",
    agent: "codex",
    status: "idle",
    phase: "idle",
    turns: [{ userPrompt: raw, lastMessage: raw, status: "idle", phase: "idle" }],
    lastMessage: raw,
    summary: raw,
  };
  const snapshot = structuredClone(session);

  for (const t of [english, chinese]) {
    assert.equal(displayAiSessionTitle(session, 0, t), raw);
    assert.equal(displayAiSessionMessage(session, 0, t), raw);
    assert.equal(displayAiSessionResponse(session, 0, t), raw);
  }
  assert.deepEqual(session, snapshot);
});

test("raw tool names and previews are appended outside localized presentation", () => {
  const session = {
    id: "ai_tool_raw",
    agent: "codex",
    status: "running",
    phase: "tool",
    currentTool: { name: raw, inputPreview: raw },
    turns: [],
  };

  assert.equal(aiSessionStatusLabel(session, english), `Running · ${raw}`);
  assert.equal(aiSessionStatusLabel(session, chinese), `运行中 · ${raw}`);
  assert.equal(displayAiSessionMessage(session, undefined, english), `Running ${raw}: ${raw}`);
  assert.equal(displayAiSessionMessage(session, undefined, chinese), `运行中 ${raw}: ${raw}`);
});

test("tool activity does not interpolate authoritative summary or tool fields through t", () => {
  const source = fs.readFileSync(new URL("../src/components/ai-session/AiSessionToolActivity.vue", import.meta.url), "utf8");
  assert.match(source, /\$\{t\("sessions\.status\.waitingApproval"\)\} · \$\{props\.summary\}/);
  assert.doesNotMatch(source, /t\([^)]*,\s*\{[^}]*props\.(?:summary|currentTool)/);
});

test("attachment-only provider content is locale-neutral and outside translation resources", () => {
  assert.equal(aiSessionMessageText("user input"), "user input");
  assert.equal(aiSessionMessageText(""), AI_SESSION_ATTACHMENT_ONLY_MESSAGE);
  assert.equal(aiSessionMessageText(""), "Please review the attached files.");
});
