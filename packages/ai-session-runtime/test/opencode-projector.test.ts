import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeMessage, OpenCodeSession } from "../src/opencode/wire.ts";
import { openCodeErrorText, projectOpenCodeSession } from "../src/opencode/projector.ts";

const session: OpenCodeSession = {
  id: "ses_test",
  directory: "/tmp/project",
  title: "Test",
  time: { created: 1, updated: 6 },
};

function message(role: "user" | "assistant", id: string, created: number, parts: OpenCodeMessage["parts"], parentID = "msg_user"): OpenCodeMessage {
  return {
    info: role === "user"
      ? { id, sessionID: session.id, role, time: { created } }
      : { id, sessionID: session.id, role, parentID, time: { created, completed: created + 1 } },
    parts,
  };
}

function textPart(id: string, text: string, messageID: string) {
  return { id, sessionID: session.id, messageID, type: "text" as const, text };
}

test("OpenCode turn lastMessage only carries the final assistant text part", () => {
  const projection = projectOpenCodeSession({
    session,
    status: { type: "idle" },
    permissions: [],
    messages: [
      message("user", "msg_user", 1, [textPart("prt_user", "first prompt", "msg_user")]),
      message("assistant", "msg_assistant_1", 2, [textPart("prt_text_1", "Investigating the issue.", "msg_assistant_1")]),
      message("assistant", "msg_assistant_2", 3, [textPart("prt_text_2", "Fixed and verified.", "msg_assistant_2")]),
    ],
  });

  const turn = projection.snapshot.turns?.[0];
  assert.equal(turn?.lastMessage, "Fixed and verified.");
  assert.equal(turn?.lastMessageItemId, "prt_text_2");
  assert.deepEqual(
    projection.timeline.flatMap((item) => item.type === "ai-message" ? [item.text] : []),
    ["Investigating the issue.", "Fixed and verified."],
  );
});

test("OpenCode user aborts are interruptions rather than session failures", () => {
  const aborted = { name: "MessageAbortedError", data: { message: "Aborted" } };
  assert.equal(openCodeErrorText(aborted), undefined);

  const projection = projectOpenCodeSession({
    session,
    status: { type: "idle" },
    permissions: [],
    messages: [
      message("user", "msg_user", 1, [textPart("prt_user", "Inspect the image", "msg_user")]),
      {
        info: {
          id: "msg_assistant",
          sessionID: session.id,
          role: "assistant",
          parentID: "msg_user",
          time: { created: 2, completed: 3 },
          error: aborted,
        },
        parts: [textPart("prt_text", "I cannot inspect the image.", "msg_assistant")],
      },
    ],
  });

  assert.equal(projection.snapshot.status, "idle");
  assert.equal(projection.snapshot.error, undefined);
  assert.equal(projection.snapshot.turns?.[0]?.status, "completed");
});

test("OpenCode preserves real assistant errors", () => {
  const projection = projectOpenCodeSession({
    session,
    status: { type: "idle" },
    permissions: [],
    messages: [
      message("user", "msg_user", 1, [textPart("prt_user", "Run it", "msg_user")]),
      {
        info: {
          id: "msg_assistant",
          sessionID: session.id,
          role: "assistant",
          parentID: "msg_user",
          time: { created: 2, completed: 3 },
          error: { name: "APIError", data: { message: "Provider failed", isRetryable: false } },
        },
        parts: [],
      },
    ],
  });

  assert.equal(projection.snapshot.status, "failed");
  assert.equal(projection.snapshot.error, "Provider failed");
  assert.equal(projection.snapshot.turns?.[0]?.status, "failed");
});
