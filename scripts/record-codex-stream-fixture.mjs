#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const DEFAULT_OUTPUT = "test/fixtures/ai-session/codex-markdown-stream.real.jsonl";
const DEFAULT_TIMEOUT_MS = 180_000;
const PROMPT = [
  "Without using tools, copy the Markdown document below exactly.",
  "Do not add a preface or code fence around the whole document.",
  "# Streaming fixture",
  "",
  "第一段用于验证连续中文输出、emoji 👩🏽‍💻 和组合字符 é。追加内容必须保持顺序，不能丢失、重复或拆开 Unicode grapheme。",
  "",
  "第二段重复足够多的普通文本来产生高频 delta。流式消息经过实例、节点代理、控制面和浏览器后，最终文本必须与完成事件逐字一致。稳定段落不应随尾部字符重复解析，用户上翻后也不应被强制拉回底部。",
  "",
  "```typescript",
  "type Result = { value: number; label: string };",
  "const values: Result[] = [];",
  "for (let index = 0; index < 20; index += 1) {",
  "  values.push({ value: index, label: `row-${index}` });",
  "}",
  "const total = values.reduce((sum, entry) => sum + entry.value, 0);",
  "console.log({ total, values });",
  "```",
  "",
  "| Name | Value | State |",
  "| --- | ---: | :---: |",
  "| alpha | 1 | ready |",
  "| beta | 2 | running |",
  "| gamma | 3 | done |",
  "| delta | 4 | done |",
  "| epsilon | 5 | done |",
  "",
  "Inline formula: $E = mc^2$.",
  "",
  "$$",
  "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
  "$$",
  "",
  "```mermaid",
  "graph TD",
  "  A[Receive] --> B[Coalesce]",
  "  B --> C[Project]",
  "  C --> D[Segment]",
  "  D --> E[Render]",
  "  E --> F[Settle]",
  "```",
  "",
  "STREAM_FIXTURE_COMPLETE",
].join("\n");

const args = parseArgs(process.argv.slice(2));
const port = await availablePort();
const endpoint = `ws://127.0.0.1:${port}`;
const startedAt = Date.now();
const frames = [];
const captured = [];
let nextId = 1;
let threadId;
let turnId;
let completedText;
let totalInboundFrames = 0;
let childStderr = "";
let socket;

const child = spawn(args.command, ["app-server", "--listen", endpoint], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  childStderr = `${childStderr}${chunk}`.slice(-16_384);
});

try {
  const ws = await connectWithRetry(endpoint, child, args.timeoutMs);
  socket = ws;
  const pending = new Map();
  let resolveCompleted;
  let rejectCompleted;
  const completion = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  ws.on("message", (data) => {
    totalInboundFrames += 1;
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    frames.push({ elapsedMs, message });
    if (Number.isInteger(message.id) && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result || {});
      return;
    }
    if (Number.isInteger(message.id)) {
      ws.send(JSON.stringify({ id: message.id, result: { decision: "decline" } }));
      return;
    }
    const event = captureNotification(message, elapsedMs);
    if (event) captured.push(event);
    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      completedText = message.params.item.text;
    }
    if (message.method === "turn/completed" && message.params?.turn?.id === turnId) {
      resolveCompleted(message.params.turn);
    }
    if (message.method === "error" && message.params?.willRetry === false) {
      rejectCompleted(new Error(message.params.message || "Codex app-server reported an error."));
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, args.timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const notify = (method, params) => ws.send(JSON.stringify({ method, params }));

  await request("initialize", {
    clientInfo: { name: "task-handoff-stream-fixture-recorder", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized", {});
  const threadResult = await request("thread/start", {
    approvalPolicy: "never",
    cwd: process.cwd(),
    ephemeral: true,
    sandbox: "read-only",
  });
  threadId = threadResult.thread?.id;
  if (!threadId) throw new Error("thread/start did not return thread.id");
  const turnResult = await request("turn/start", {
    threadId,
    input: [{ type: "text", text: PROMPT, text_elements: [] }],
  });
  turnId = turnResult.turn?.id || turnResult.turnId;
  if (!turnId) throw new Error("turn/start did not return a turn id");
  const completedTurn = await withTimeout(completion, args.timeoutMs, "turn completion");
  const deltaEvents = captured.filter((event) => event.aiSessionEvent?.type === "ai-session.message-delta");
  const deltaText = deltaEvents.map((event) => event.aiSessionEvent.payload.delta).join("");
  if (!deltaEvents.length) throw new Error("The real turn produced no item/agentMessage/delta notifications.");
  if (!completedText) throw new Error("The real turn produced no completed agent message.");
  if (deltaText !== completedText) throw new Error(`Delta text (${deltaText.length}) differs from completed text (${completedText.length}).`);
  assertFixtureCoverage(completedText, deltaEvents.length);

  const metadata = {
    recordType: "metadata",
    schemaVersion: 1,
    provenance: "real-codex-app-server-websocket",
    recordedAt: new Date().toISOString(),
    codexVersion: codexVersion(args.command),
    transport: "websocket",
    promptSha256: createHash("sha256").update(PROMPT).digest("hex"),
    instanceId: "fixture-instance",
    sessionId: threadId,
    providerSessionId: threadId,
    turnId,
    completionStatus: completedTurn.status,
    totalInboundWebSocketFrames: totalInboundFrames,
    capturedEventCount: captured.length,
    rawDeltaCount: deltaEvents.length,
    firstDeltaElapsedMs: deltaEvents[0].elapsedMs,
    lastDeltaElapsedMs: deltaEvents.at(-1).elapsedMs,
    completedTextSha256: createHash("sha256").update(completedText).digest("hex"),
    completedTextLength: completedText.length,
  };
  const lines = [metadata, ...captured].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, lines, "utf8");
  console.log(JSON.stringify({ output: args.output, ...metadata }, null, 2));
  ws.close();
} catch (error) {
  const detail = childStderr.trim();
  console.error(detail ? `${error.message}\napp-server stderr:\n${detail}` : error.message);
  process.exitCode = 1;
} finally {
  socket?.terminate();
  await stopChild(child);
}

async function stopChild(processHandle) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => processHandle.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    processHandle.kill("SIGKILL");
    await new Promise((resolve) => processHandle.once("exit", resolve));
  }
}

function captureNotification(message, elapsedMs) {
  const params = message.params || {};
  if (message.method === "item/agentMessage/delta") {
    const generatedAt = new Date(startedAt + elapsedMs).toISOString();
    return {
      recordType: "event",
      elapsedMs,
      raw: {
        method: message.method,
        params: { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta },
      },
      aiSessionEvent: {
        type: "ai-session.message-delta",
        payload: {
          instanceId: "fixture-instance",
          sessionId: params.threadId,
          providerSessionId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          delta: params.delta,
          generatedAt,
        },
      },
    };
  }
  if (message.method === "turn/started" || message.method === "turn/completed") {
    return {
      recordType: "event",
      elapsedMs,
      raw: {
        method: message.method,
        params: {
          threadId: params.threadId,
          turn: params.turn && { id: params.turn.id, status: params.turn.status },
        },
      },
    };
  }
  if (message.method === "item/completed" && params.item?.type === "agentMessage") {
    return {
      recordType: "event",
      elapsedMs,
      raw: {
        method: message.method,
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          item: { id: params.item.id, type: params.item.type, text: params.item.text },
        },
      },
    };
  }
  return undefined;
}

function assertFixtureCoverage(text, deltaCount) {
  const checks = [
    ["TypeScript fence", /```(?:ts|typescript)\n[\s\S]+?```/],
    ["GFM table", /\|[^\n]+\|\n\|\s*:?-{3,}/],
    ["inline KaTeX", /\$[^\n$]+\$/],
    ["display KaTeX", /\$\$[\s\S]+?\$\$/],
    ["Mermaid", /```mermaid\n[\s\S]+?```/],
    ["emoji", /👩🏽‍💻/u],
    ["completion marker", /STREAM_FIXTURE_COMPLETE/],
  ];
  for (const [label, pattern] of checks) {
    if (!pattern.test(text)) throw new Error(`Recorded response is missing required coverage: ${label}`);
  }
  if (deltaCount < 20) throw new Error(`Expected a high-frequency stream, received only ${deltaCount} deltas.`);
}

function parseArgs(argv) {
  const parsed = { command: process.env.TASK_HANDOFF_CODEX_COMMAND || "codex", output: DEFAULT_OUTPUT, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") parsed.output = argv[++index];
    else if (argv[index] === "--command") parsed.command = argv[++index];
    else if (argv[index] === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return parsed;
}

function codexVersion(command) {
  return spawnSync(command, ["--version"], { encoding: "utf8" }).stdout.trim();
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function connectWithRetry(endpoint, child, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Codex app-server exited with code ${child.exitCode}.`);
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out connecting to ${endpoint}.`);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs)),
  ]);
}
