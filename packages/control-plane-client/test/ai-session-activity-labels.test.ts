import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSessionActivityTitleKey,
  aiSessionToolNameKey,
  localizedAiSessionActivityTitle,
  localizedAiSessionToolName,
  type AiSessionActivityTitleTranslationKey,
} from "../src/ai-session-activity-labels.ts";

const values: Partial<Record<AiSessionActivityTitleTranslationKey, string>> = {
  "sessions.timeline.activityTitle.command": "命令",
  "sessions.timeline.activityTitle.fileChange": "文件变更",
  "sessions.timeline.activityTitle.search": "搜索",
  "sessions.timeline.activityTitle.read": "读取",
};
const t = (key: AiSessionActivityTitleTranslationKey) => values[key] ?? key;

test("maps backend activity and tool labels to translation keys", () => {
  assert.equal(aiSessionActivityTitleKey({ activityKind: "commandExecution", title: "Command" }), "sessions.timeline.activityTitle.command");
  assert.equal(aiSessionActivityTitleKey({ activityKind: "fileChange", title: "File change" }), "sessions.timeline.activityTitle.fileChange");
  assert.equal(aiSessionActivityTitleKey({ activityKind: "fileSearch", title: "Search" }), "sessions.timeline.activityTitle.search");
  assert.equal(aiSessionActivityTitleKey({ activityKind: "fileRead", title: "Read" }), "sessions.timeline.activityTitle.read");
  assert.equal(aiSessionToolNameKey("Search"), "sessions.timeline.activityTitle.search");
  assert.equal(aiSessionToolNameKey("Read"), "sessions.timeline.activityTitle.read");
});

test("localizes known labels without changing arbitrary backend tool names", () => {
  assert.equal(localizedAiSessionActivityTitle({ activityKind: "commandExecution", title: "Command" }, t), "命令");
  assert.equal(localizedAiSessionActivityTitle({ activityKind: "dynamicToolCall", title: "custom_tool · action" }, t), "custom_tool · action");
  assert.equal(localizedAiSessionToolName("File change", t), "文件变更");
  assert.equal(localizedAiSessionToolName("custom_tool · action", t), "custom_tool · action");
  assert.equal(aiSessionActivityTitleKey({ activityKind: "custom_tool", title: "Custom title" }), undefined);
  assert.equal(aiSessionToolNameKey("custom_tool · action"), undefined);
});
