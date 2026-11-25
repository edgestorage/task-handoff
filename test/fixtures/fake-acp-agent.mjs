import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessionId = "shared-acp-session";
const input = createInterface({ input: process.stdin });
let pendingPrompt;
const configuration = process.argv[2];
const unlistedLegacy = configuration === "legacy-unlisted-model";
const legacy = configuration === "legacy-models" || configuration === "legacy-no-load" || unlistedLegacy;
const emptyEffortCurrent = configuration === "dsh-empty-effort-current";
const permissionModes = configuration === "gemini-modes"
  ? [
      { id: "default", name: "Default", description: "Prompts for approval" },
      { id: "autoEdit", name: "Auto Edit", description: "Auto-approves edit tools" },
      { id: "yolo", name: "YOLO", description: "Auto-approves all tools" },
      { id: "plan", name: "Plan", description: "Read-only mode" },
    ]
  : configuration === "commandcode-modes"
    ? [
        { id: "default", name: "Standard", description: "Ask before running tools that change anything." },
        { id: "auto-accept", name: "Accept Edits", description: "Auto-accept file edits; still ask for riskier actions." },
        { id: "plan", name: "Plan", description: "Research and plan only — no edits or commands." },
        { id: "dont-ask", name: "Don't Ask", description: "Run without prompting, keeping the safety rails on." },
        { id: "bypass", name: "Bypass Permissions", description: "Skip every permission check (use with care)." },
      ]
    : undefined;
const modelValues = configuration === "dsh-json" || emptyEffortCurrent
  ? [JSON.stringify(["task-handoff-demo", "model-a"]), JSON.stringify(["task-handoff-demo", "model-b"])]
  : configuration === "commandcode"
    ? ["task-handoff-demo/model-a", "task-handoff-demo/model-b"]
    : ["model-a", "model-b"];
let currentModel = unlistedLegacy ? "configured-model" : modelValues[0];
let currentEffort = "medium";
let currentMode = permissionModes?.[0]?.id;
const configOptions = () => [{
  id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel,
  options: modelValues.map((value, index) => ({ value, name: `Model ${String.fromCharCode(65 + index)}` })),
}, {
  id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: currentEffort,
  options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
}];
const legacyModels = () => ({
  currentModelId: currentModel,
  availableModels: unlistedLegacy
    ? [{ modelId: "auto", name: "Auto" }, { modelId: "gemini-2.5-pro", name: "gemini-2.5-pro" }]
    : modelValues.map((value, index) => ({ modelId: value, name: `Model ${String.fromCharCode(65 + index)}` })),
});
const sessionPayload = () => ({
  ...(legacy ? { models: legacyModels() } : { configOptions: configOptions() }),
  ...(permissionModes ? { modes: { currentModeId: currentMode, availableModes: permissionModes } } : {}),
});
const chunk = (text) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
const update = (update) => send({ method: "session/update", params: { sessionId, update } });

for await (const line of input) {
  const request = JSON.parse(line);
  const result = (value) => send({ id: request.id, result: value });
  if (request.method === "initialize") {
    result({ protocolVersion: 1, agentCapabilities: {
      loadSession: configuration !== "no-load" && configuration !== "legacy-no-load",
      promptCapabilities: { image: configuration === "image" },
    } });
  } else if (request.method === "session/new") {
    result({ sessionId, ...sessionPayload() });
  } else if (request.method === "session/options") {
    result(sessionPayload());
  } else if (request.method === "session/set_config_option") {
    const option = request.params.configId === "model"
      ? { values: modelValues }
      : request.params.configId === "effort"
        ? { values: ["low", "medium", "high"] }
        : undefined;
    if (!option || !option.values.includes(request.params.value)) {
      send({ id: request.id, error: { code: -32602, message: "Invalid config option value" } });
    } else {
      if (request.params.configId === "model") {
        currentModel = request.params.value;
        if (emptyEffortCurrent) currentEffort = "";
      }
      else currentEffort = request.params.value;
      const payload = configOptions();
      result({ configOptions: payload });
      update({ sessionUpdate: "config_option_update", configOptions: payload });
    }
  } else if (request.method === "session/set_model") {
    if (!legacy || (!unlistedLegacy && !modelValues.includes(request.params.modelId))) {
      send({ id: request.id, error: { code: -32601, message: "Method not found" } });
    } else {
      currentModel = request.params.modelId;
      result({});
      update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
    }
  } else if (request.method === "session/set_mode") {
    if (!permissionModes?.some(({ id }) => id === request.params.modeId)) {
      send({ id: request.id, error: { code: -32602, message: "Unknown session mode" } });
    } else {
      currentMode = request.params.modeId;
      result({});
      update({ sessionUpdate: "current_mode_update", currentModeId: currentMode });
    }
  } else if (request.method === "session/load" && request.params.sessionId === sessionId) {
    if (configuration === "replay-known") {
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "known prompt" } });
      chunk("recovered reply");
    } else chunk("historical replay");
    if (configuration === "failed-load") send({ id: request.id, error: { code: -32603, message: "Load failed after replay" } });
    else result(sessionPayload());
  } else if (request.method === "session/prompt") {
    const mode = (request.params.prompt.find((block) => block.type === "text")?.text ?? "").split("\n")[0];
    if (mode === "exit") process.exit(1);
    if (mode === "attachments") {
      chunk(request.params.prompt.map((block) => block.type === "image" ? `image:${block.mimeType}` : block.type).join(","));
      result({ stopReason: "end_turn" });
    } else if (mode === "selected-model") {
      chunk(currentModel);
      result({ stopReason: "end_turn" });
    } else if (mode === "selected-effort") {
      chunk(currentEffort);
      result({ stopReason: "end_turn" });
    } else if (mode === "selected-mode") {
      chunk(currentMode ?? "none");
      result({ stopReason: "end_turn" });
    } else if (mode === "approval" || mode === "cancel" || mode === "exit-pending") {
      pendingPrompt = request.id;
      chunk("before approval");
      send({ id: "permission", method: "session/request_permission", params: {
        sessionId,
        toolCall: { toolCallId: "tool-1", title: "Fake permission" },
        options: [{ optionId: "approve-once", name: "Allow once", kind: "allow_once" }],
      } });
      if (mode === "exit-pending") setTimeout(() => process.exit(1), 250);
    } else if (mode === "tools") {
      chunk("before");
      update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read file", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "tool output" } }] });
      chunk("after");
      result({ stopReason: "end_turn" });
    } else if (mode === "tool-kinds") {
      chunk("before");
      update({
        sessionUpdate: "tool_call", toolCallId: "list-1", title: "List:/root", kind: "other",
        status: "in_progress", locations: [{ path: "/root" }], rawInput: { path: "/root" },
      });
      update({ sessionUpdate: "tool_call_update", toolCallId: "list-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "- /root/notes.txt" } }] });
      update({
        sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read file", name: "read_file", kind: "read",
        status: "in_progress", locations: [{ path: "/root/notes.txt" }], rawInput: { file_path: "/root/notes.txt" },
      });
      update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "alpha" } }] });
      update({
        sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Edit file", name: "edit_file", kind: "edit",
        status: "in_progress", locations: [{ path: "/root/notes.txt" }],
      });
      update({
        sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed",
        content: [{ type: "diff", path: "/root/notes.txt", oldText: "before\n", newText: "after\n" }],
      });
      update({
        sessionUpdate: "tool_call", toolCallId: "search-1", title: "Search files", name: "grep", kind: "search",
        status: "in_progress", locations: [{ path: "/root" }], rawInput: { query: "needle", path: "/root" },
      });
      update({ sessionUpdate: "tool_call_update", toolCallId: "search-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "/root/notes.txt:1:needle" } }] });
      update({
        sessionUpdate: "tool_call", toolCallId: "exec-1", title: "Run command", name: "shell", kind: "execute",
        status: "in_progress", rawInput: { command: "printf", args: ["hi"] },
      });
      update({
        sessionUpdate: "tool_call_update", toolCallId: "exec-1", status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hi" } }], rawOutput: { exitCode: 0, output: "hi" },
      });
      update({
        sessionUpdate: "tool_call", toolCallId: "fetch-1", title: "Fetch page", name: "fetch", kind: "fetch",
        status: "in_progress", rawInput: { url: "https://example.com/docs" },
      });
      update({ sessionUpdate: "tool_call_update", toolCallId: "fetch-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "page" } }] });
      update({ sessionUpdate: "tool_call", toolCallId: "think-1", title: "Thinking", name: "think", kind: "think", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "think-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "reasoned" } }] });
      update({ sessionUpdate: "tool_call", toolCallId: "other-1", title: "Custom tool", name: "custom_tool", kind: "other", status: "in_progress", rawInput: { value: 1 } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "other-1", status: "completed", rawOutput: { ok: true } });
      chunk("after");
      result({ stopReason: "end_turn" });
    } else {
      for (const text of ["one", " two"]) chunk(text);
      result({ stopReason: "end_turn" });
    }
  } else if (request.method === "session/cancel" && pendingPrompt !== undefined) {
    send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
    pendingPrompt = undefined;
  } else if (request.id === "permission") {
    if (pendingPrompt === undefined || request.result?.outcome?.outcome === "cancelled") continue;
    chunk(request.result?.outcome?.optionId ?? "missing option");
    send({ id: pendingPrompt, result: { stopReason: "end_turn" } });
    pendingPrompt = undefined;
  } else if (request.id !== undefined) {
    send({ id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}
