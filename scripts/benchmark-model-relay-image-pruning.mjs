import { performance } from "node:perf_hooks";
import { pruneModelRelayImages } from "../packages/control-plane/src/node-agent/models/relay/image-pruning.ts";

const MIB = 1024 * 1024;
const SIZES_MIB = [8, 16, 32];
const IMAGE_COUNT = 10;
const KEEP_LATEST = 4;

function memorySnapshot() {
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss, maxRss: process.resourceUsage().maxRSS * 1024 };
}

function createBody(targetBytes) {
  const payload = {
    model: "benchmark-model",
    input: [{
      role: "user",
      content: Array.from({ length: IMAGE_COUNT }, (_, index) => ({
        type: "input_image",
        image_url: `data:image/png;base64,${index}`,
        detail: "low",
      })),
    }],
  };
  const skeletonBytes = Buffer.byteLength(JSON.stringify(payload));
  const dataBytes = Math.max(1, Math.floor((targetBytes - skeletonBytes) / IMAGE_COUNT));
  const imageData = "A".repeat(dataBytes);
  payload.input[0].content = Array.from({ length: IMAGE_COUNT }, (_, index) => ({
    type: "input_image",
    image_url: `data:image/png;base64,${imageData}${index}`,
    detail: "low",
  }));
  return JSON.stringify(payload);
}

function measureOne(targetBytes) {
  const before = memorySnapshot();
  const raw = createBody(targetBytes);
  const startedAt = performance.now();
  const parsed = JSON.parse(raw);
  const result = pruneModelRelayImages("openai-responses", parsed, KEEP_LATEST);
  const outgoing = result.changed ? JSON.stringify(result.json) : raw;
  const elapsedMs = performance.now() - startedAt;
  const after = memorySnapshot();
  return {
    targetMiB: targetBytes / MIB,
    inputMiB: Number((Buffer.byteLength(raw) / MIB).toFixed(2)),
    outputMiB: Number((Buffer.byteLength(outgoing) / MIB).toFixed(2)),
    pruneToFirstByteMs: Number(elapsedMs.toFixed(2)),
    removedImages: result.removedImages,
    retainedImages: result.retainedImages,
    heapDeltaMiB: Number(((after.heapUsed - before.heapUsed) / MIB).toFixed(2)),
    rssDeltaMiB: Number(((after.rss - before.rss) / MIB).toFixed(2)),
    maxRssMiB: Number((after.maxRss / MIB).toFixed(2)),
  };
}

async function measureConcurrent(targetBytes, concurrency = 2) {
  const before = memorySnapshot();
  const startedAt = performance.now();
  const results = await Promise.all(Array.from({ length: concurrency }, async () => measureOne(targetBytes)));
  const elapsedMs = performance.now() - startedAt;
  const after = memorySnapshot();
  return {
    targetMiB: targetBytes / MIB,
    concurrency,
    wallMs: Number(elapsedMs.toFixed(2)),
    requests: results,
    combinedHeapDeltaMiB: Number(((after.heapUsed - before.heapUsed) / MIB).toFixed(2)),
    combinedRssDeltaMiB: Number(((after.rss - before.rss) / MIB).toFixed(2)),
  };
}

const rows = [];
for (const sizeMiB of SIZES_MIB) rows.push(measureOne(sizeMiB * MIB));
const concurrent = [];
for (const sizeMiB of SIZES_MIB) concurrent.push(await measureConcurrent(sizeMiB * MIB));

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), keepLatestImages: KEEP_LATEST, rows, concurrent }, null, 2));
