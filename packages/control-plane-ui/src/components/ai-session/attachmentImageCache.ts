import { shallowReactive } from "vue";

export type AttachmentImageState = {
  status: "idle" | "loading" | "ready" | "error";
  progress?: number;
  src?: string;
  blob?: Blob;
};

type CacheEntry = {
  references: number;
  lastUsedAt: number;
  state: AttachmentImageState;
};

const MAX_INACTIVE_IMAGES = 48;
const entries = new Map<string, CacheEntry>();

function entryFor(url: string) {
  let entry = entries.get(url);
  if (!entry) {
    entry = {
      references: 0,
      lastUsedAt: Date.now(),
      state: shallowReactive<AttachmentImageState>({ status: "idle" }),
    };
    entries.set(url, entry);
  }
  return entry;
}

export function attachmentImageState(url: string) {
  return entryFor(url).state;
}

export function acquireAttachmentImage(url: string) {
  const entry = entryFor(url);
  entry.references += 1;
  entry.lastUsedAt = Date.now();
  if (entry.state.status === "idle") void loadAttachmentImage(url);
  return entry.state;
}

export function releaseAttachmentImage(url: string) {
  const entry = entries.get(url);
  if (!entry) return;
  entry.references = Math.max(0, entry.references - 1);
  entry.lastUsedAt = Date.now();
  pruneInactiveImages();
}

export function retryAttachmentImage(url: string) {
  return loadAttachmentImage(url, true);
}

async function loadAttachmentImage(url: string, force = false) {
  const entry = entryFor(url);
  if (!force && (entry.state.status === "loading" || entry.state.status === "ready")) return;
  if (entry.state.src) URL.revokeObjectURL(entry.state.src);
  Object.assign(entry.state, { status: "loading", progress: undefined, src: undefined, blob: undefined });
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error("attachment unavailable");
    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const chunks: ArrayBuffer[] = [];
    let received = 0;
    if (total > 0) entry.state.progress = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      const chunk = result.value;
      chunks.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
      received += chunk.byteLength;
      if (total > 0) entry.state.progress = Math.min(99, Math.round(received / total * 100));
    }
    const blob = new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
    const src = URL.createObjectURL(blob);
    Object.assign(entry.state, { status: "ready", progress: 100, src, blob });
  } catch {
    Object.assign(entry.state, { status: "error", progress: undefined, src: undefined, blob: undefined });
  }
  entry.lastUsedAt = Date.now();
  pruneInactiveImages();
}

function pruneInactiveImages() {
  const inactive = [...entries.entries()]
    .filter(([, entry]) => entry.references === 0 && entry.state.status !== "loading")
    .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
  while (inactive.length > MAX_INACTIVE_IMAGES) {
    const [url, entry] = inactive.shift()!;
    if (entry.state.src) URL.revokeObjectURL(entry.state.src);
    entries.delete(url);
  }
}
