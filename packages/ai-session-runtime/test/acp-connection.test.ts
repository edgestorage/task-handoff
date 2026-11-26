import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { methods } from "@agentclientprotocol/sdk";
import { connectAcp } from "../src/acp-connection.ts";

test("ACP stdio receives ordered updates before prompt completion", { timeout: 10_000 }, async () => {
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const executable = process.execPath;
  const fixture = fileURLToPath(new URL("../../../test/fixtures/fake-acp-agent.mjs", import.meta.url));
  const updates: string[] = [];
  const connection = await connectAcp({ executable, args: [fixture], env: {} }, cwd, {
    update: ({ update }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") updates.push(update.content.text);
    },
    permission: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  try {
    assert.equal(connection.capabilities?.loadSession, true);
    const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
    assert.equal(sessionId, "shared-acp-session");
    const { stopReason } = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
    assert.equal(stopReason, "end_turn");
    assert.deepEqual(updates, ["one", " two"]);
  } finally {
    await connection.close();
  }
});
