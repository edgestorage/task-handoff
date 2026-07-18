#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { AiSessionMessageDeltaCoalescer } from "../packages/controlled-instance/src/web/ai-session-message-delta-coalescer.ts";
import { createStreamingTestEnvironment } from "../test/support/streaming-test-tools.mjs";

const output = argument("--output");
const transport = benchmarkTransport();

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  configuration: {
    coalescingWindowMs: 32,
    rawDeltaIntervalMs: 1,
  },
  transport,
  comparison: {
    workload: "2048 one-character deltas at 1ms intervals",
    previousPath: {
      browserEvents: transport.rawDeltaEvents,
      tanstackQueryTreeCopies: transport.rawDeltaEvents,
      minimumWholeMessageMarkdownTriggersPerFullView: transport.rawDeltaEvents,
    },
    optimizedPath: {
      browserEvents: transport.coalescedEvents,
      tanstackQueryTreeCopies: 0,
      streamingStoreUpdates: transport.coalescedEvents,
    },
  },
};

assertBudgets(result);
const json = `${JSON.stringify(result, null, 2)}\n`;
if (output) await writeFile(output, json, "utf8");
process.stdout.write(json);

function benchmarkTransport() {
  const transportEnvironment = createStreamingTestEnvironment({ frameDuration: 16 });
  const emitted = [];
  let receivedText = "";
  const coalescer = new AiSessionMessageDeltaCoalescer({
    clock: transportEnvironment.clock,
    windowMs: 32,
    emit: (payload) => {
      emitted.push(payload);
      receivedText += payload.delta;
    },
  });
  const expected = "streaming-text-".repeat(160).slice(0, 2_048);
  for (let index = 0; index < expected.length; index += 1) {
    coalescer.push({
      instanceId: "benchmark-instance",
      sessionId: "benchmark-session",
      providerSessionId: "benchmark-session",
      turnId: "benchmark-turn",
      itemId: "benchmark-item",
      delta: expected[index],
      generatedAt: new Date(index).toISOString(),
    });
    transportEnvironment.clock.advanceBy(1);
  }
  coalescer.close("completed");
  const diagnostics = coalescer.diagnostics();

  return {
    rawDeltaEvents: diagnostics.rawDeltaCount,
    coalescedEvents: diagnostics.emittedEventCount,
    eventReductionPercent: round((1 - diagnostics.emittedEventCount / diagnostics.rawDeltaCount) * 100),
    maxBatchSize: diagnostics.maxBatchSize,
    maxFirstBatchWaitMs: diagnostics.maxFirstBatchWaitMs,
    finalTextMatches: receivedText === expected,
  };
}

function assertBudgets(value) {
  if (!value.transport.finalTextMatches) throw new Error("Streaming text did not converge exactly.");
  if (value.transport.maxFirstBatchWaitMs > value.configuration.coalescingWindowMs) throw new Error("Coalescing exceeded its configured window.");
  if (value.transport.coalescedEvents >= value.transport.rawDeltaEvents) throw new Error("Transport coalescing did not reduce events.");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
