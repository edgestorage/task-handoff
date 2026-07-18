#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { renderMarkdown } from "../packages/web-theme/markdown.ts";

const args = parseArgs(process.argv.slice(2));
const records = (await readFile(args.fixture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const [metadata, ...events] = records;
if (metadata.provenance !== "real-codex-app-server-websocket") {
  throw new Error(`Refusing non-real fixture provenance: ${metadata.provenance || "missing"}`);
}
const deltas = events.filter((event) => event.aiSessionEvent?.type === "ai-session.message-delta");
const turnStarted = events.find((event) => event.raw.method === "turn/started");
const completed = events.find((event) => event.raw.method === "item/completed" && event.raw.params.item?.type === "agentMessage");
let source = "";
let markdownCalls = 0;
let highlightCalls = 0;
let katexCalls = 0;
let mermaidCalls = 0;
let tableCalls = 0;
let totalRenderMs = 0;
let maxRenderMs = 0;
let synchronousCallsAtLeast50Ms = 0;
const renderSamplesMs = [];

for (const event of deltas) {
  source += event.aiSessionEvent.payload.delta;
  for (let view = 0; view < args.fullViews; view += 1) {
    const expected = expectedHeavyCalls(source);
    const before = performance.now();
    renderMarkdown(source);
    const duration = performance.now() - before;
    markdownCalls += 1;
    highlightCalls += expected.highlight;
    katexCalls += expected.katex;
    mermaidCalls += expected.mermaid;
    tableCalls += expected.table;
    totalRenderMs += duration;
    maxRenderMs = Math.max(maxRenderMs, duration);
    if (duration >= 50) synchronousCallsAtLeast50Ms += 1;
    renderSamplesMs.push(duration);
  }
}

const completedText = completed?.raw.params.item.text;
if (!completedText || source !== completedText) throw new Error("Fixture deltas do not converge to the completed agent message.");
renderSamplesMs.sort((left, right) => left - right);
const result = {
  schemaVersion: 1,
  fixture: args.fixture,
  fixtureRecordedAt: metadata.recordedAt,
  codexVersion: metadata.codexVersion,
  assumptions: {
    fullMarkdownViews: args.fullViews,
    queryUpdates: "one setQueryData call per valid message delta in the recorded pre-change useAiSessionStore.applyMessageDelta path",
    heavyCalls: "source-derived count per pre-change full render, verified against markdown.ts and the former whole-message MarkdownContent call boundary",
    longTasks: "synchronous Node render calls >=50ms; browser PerformanceLongTaskTiming must be captured separately",
  },
  transport: {
    totalInboundWebSocketFrames: metadata.totalInboundWebSocketFrames,
    capturedEvents: metadata.capturedEventCount,
    rawMessageDeltaEvents: deltas.length,
    firstCharacterLatencyMs: turnStarted ? deltas[0].elapsedMs - turnStarted.elapsedMs : null,
    streamDurationMs: deltas.at(-1).elapsedMs - deltas[0].elapsedMs,
  },
  currentUiProjection: {
    querySetDataCalls: deltas.length,
    fullSessionTreeCopies: deltas.length,
  },
  currentMarkdown: {
    calls: markdownCalls,
    highlightCalls,
    katexCalls,
    mermaidCalls,
    tableCalls,
    totalRenderMs: round(totalRenderMs),
    maxRenderMs: round(maxRenderMs),
    p50RenderMs: round(percentile(renderSamplesMs, 0.5)),
    p95RenderMs: round(percentile(renderSamplesMs, 0.95)),
    synchronousCallsAtLeast50Ms,
  },
  convergence: {
    finalTextMatches: true,
    finalTextLength: completedText.length,
  },
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (args.output) await writeFile(args.output, json, "utf8");
process.stdout.write(json);

function expectedHeavyCalls(markdown) {
  const closedFences = [...markdown.matchAll(/^```([^\n]*)\n[\s\S]*?^```\s*$/gm)];
  const languageNames = new Set(["bash", "cpp", "csharp", "css", "dockerfile", "go", "java", "javascript", "json", "kotlin", "markdown", "php", "python", "ruby", "rust", "sql", "swift", "typescript", "xml", "yaml"]);
  return {
    highlight: closedFences.filter((match) => languageNames.has(match[1].trim().split(/\s+/, 1)[0].toLowerCase())).length,
    mermaid: closedFences.filter((match) => match[1].trim().split(/\s+/, 1)[0].toLowerCase() === "mermaid").length,
    katex: countMatches(markdown, /\$\$[\s\S]+?\$\$/g) + countMatches(markdown.replace(/\$\$[\s\S]+?\$\$/g, ""), /\$(?!\s)[^\n$]+?\$/g),
    table: countMatches(markdown, /^\|[^\n]+\|\n\|\s*:?-{3,}[^\n]*\|/gm),
  };
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(argv) {
  const parsed = { fixture: "test/fixtures/ai-session/codex-markdown-stream.real.jsonl", output: undefined, fullViews: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--fixture") parsed.fixture = argv[++index];
    else if (argv[index] === "--output") parsed.output = argv[++index];
    else if (argv[index] === "--full-views") parsed.fullViews = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(parsed.fullViews) || parsed.fullViews < 1) throw new Error("--full-views must be a positive integer");
  return parsed;
}
