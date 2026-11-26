import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const capturePath = process.env.FAKE_ACP_CAPTURE;
const sessionId = "story-acp-session";
const input = createInterface({ input: process.stdin });
let captureStarted = false;

function capture(request) {
  if (!capturePath) return;
  if (!captureStarted) {
    writeFileSync(capturePath, "");
    captureStarted = true;
  }
  appendFileSync(capturePath, `${JSON.stringify({ method: request.method, params: request.params })}\n`);
}

for await (const line of input) {
  const request = JSON.parse(line);
  const result = (value) => send({ id: request.id, result: value });
  if (request.method === "initialize") {
    result({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        ...(process.env.FAKE_ACP_SYSTEM_PROMPT === "absent"
          ? {}
          : { sessionCapabilities: { systemPrompt: {} } }),
      },
    });
  } else if (request.method === "session/new") {
    capture(request);
    if (process.env.FAKE_ACP_REJECT_PROMPT === "1" && request.params.systemPrompt) {
      send({ id: request.id, error: { code: -32602, message: "append unsupported" } });
    } else {
      result({ sessionId });
    }
  } else if (request.method === "session/load") {
    capture(request);
    result({});
  } else if (request.method === "session/prompt") {
    capture(request);
    const text = request.params.prompt.find((block) => block.type === "text")?.text ?? "";
    send({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } } },
    });
    result({ stopReason: "end_turn" });
  } else {
    send({ id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}
