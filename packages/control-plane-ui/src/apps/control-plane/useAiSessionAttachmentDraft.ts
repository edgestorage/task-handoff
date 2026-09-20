import type { AiSessionPastedTextPresentation } from "@task-handoff/control-plane-client";
import { onScopeDispose, ref, toRaw, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { AiSessionComposerAttachment } from "../../components/ai-session/AiSessionComposer.vue";
import { AI_SESSION_DRAFT_TTL_MS } from "./useAiSessionDraft.ts";

const DATABASE_NAME = "task-handoff.control-plane.ai-session-drafts";
const DATABASE_VERSION = 1;
const STORE_NAME = "attachment-drafts";
const MAX_ATTACHMENTS = 6;
const MAX_PERSISTED_PREVIEW_BYTES = 20 * 1024 * 1024;

type StoredAttachment = Pick<AiSessionComposerAttachment, "id" | "kind" | "name" | "mime" | "size" | "source"> & {
  dataUrl?: string;
  file?: File;
  textPresentation?: AiSessionPastedTextPresentation;
};

type StoredAttachmentDraft = {
  draftKey: string;
  attachments: StoredAttachment[];
  updatedAt: number;
};

let databasePromise: Promise<IDBDatabase | undefined> | undefined;
const pendingWrites = new Map<string, Promise<void>>();

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  databasePromise ||= new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "draftKey" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(undefined));
    request.addEventListener("blocked", () => resolve(undefined));
  });
  return databasePromise;
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function storedAttachment(attachment: AiSessionComposerAttachment): StoredAttachment {
  const source = attachment.source.type === "runtime-path"
    ? { type: "runtime-path" as const, path: attachment.source.path }
    : { type: "inline" as const };
  const file = attachment.file ? toRaw(attachment.file) : undefined;
  const textPresentation = attachment.textPresentation
    ? {
        summary: attachment.textPresentation.summary,
        codePointLength: attachment.textPresentation.codePointLength,
      }
    : undefined;
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    source,
    ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
    ...(attachment.kind === "image" && source.type === "runtime-path"
      && file && file.size <= MAX_PERSISTED_PREVIEW_BYTES
      ? { file }
      : {}),
    ...(textPresentation ? { textPresentation } : {}),
  };
}

function restoredAttachment(value: unknown): AiSessionComposerAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attachment = value as Partial<StoredAttachment>;
  if (typeof attachment.id !== "string" || !attachment.id
    || (attachment.kind !== "image" && attachment.kind !== "file")
    || typeof attachment.name !== "string" || typeof attachment.mime !== "string"
    || !Number.isFinite(attachment.size) || (attachment.size as number) <= 0
    || !attachment.source || typeof attachment.source !== "object") return undefined;
  const source = attachment.source.type === "inline"
    ? { type: "inline" as const }
    : attachment.source.type === "runtime-path" && typeof attachment.source.path === "string" && attachment.source.path.startsWith("/")
      ? { type: "runtime-path" as const, path: attachment.source.path }
      : undefined;
  if (!source || (source.type === "inline" && (typeof attachment.dataUrl !== "string" || !attachment.dataUrl.startsWith("data:")))) return undefined;
  const file = typeof File !== "undefined" && attachment.file instanceof File ? attachment.file : undefined;
  const textPresentation = attachment.textPresentation
    && typeof attachment.textPresentation.summary === "string"
    && Number.isFinite(attachment.textPresentation.codePointLength)
    ? attachment.textPresentation
    : undefined;
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size as number,
    source,
    ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
    ...(file ? { file } : {}),
    ...(textPresentation ? { textPresentation } : {}),
    ...(attachment.kind === "image" && file && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? { previewUrl: URL.createObjectURL(file) }
      : {}),
  };
}

export function serializeAiSessionAttachmentDraft(attachments: AiSessionComposerAttachment[]) {
  return attachments.slice(0, MAX_ATTACHMENTS).map(storedAttachment);
}

export function restoreAiSessionAttachmentDraft(attachments: unknown[]) {
  return attachments.flatMap((attachment) => {
    const restored = restoredAttachment(attachment);
    return restored ? [restored] : [];
  }).slice(0, MAX_ATTACHMENTS);
}

async function writeAttachmentDraft(draftKey: string, attachments: AiSessionComposerAttachment[], now: number) {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  if (attachments.length) {
    store.put({ draftKey, attachments: serializeAiSessionAttachmentDraft(attachments), updatedAt: now } satisfies StoredAttachmentDraft);
  } else {
    store.delete(draftKey);
  }
  await transactionDone(transaction);
}

export function persistAiSessionAttachmentDraft(draftKey: string, attachments: AiSessionComposerAttachment[], now = Date.now()) {
  if (!draftKey.trim()) return Promise.resolve();
  const previous = pendingWrites.get(draftKey) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeAttachmentDraft(draftKey, attachments, now)).catch(() => undefined);
  pendingWrites.set(draftKey, next);
  void next.finally(() => {
    if (pendingWrites.get(draftKey) === next) pendingWrites.delete(draftKey);
  });
  return next;
}

export async function loadAiSessionAttachmentDraft(draftKey: string, now = Date.now()) {
  if (!draftKey.trim()) return [];
  await pendingWrites.get(draftKey);
  const database = await openDatabase();
  if (!database) return [];
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const value = await requestResult(transaction.objectStore(STORE_NAME).get(draftKey)) as StoredAttachmentDraft | undefined;
    if (!value || !Number.isFinite(value.updatedAt) || now - value.updatedAt >= AI_SESSION_DRAFT_TTL_MS || !Array.isArray(value.attachments)) {
      if (value) await persistAiSessionAttachmentDraft(draftKey, [], now);
      return [];
    }
    return restoreAiSessionAttachmentDraft(value.attachments);
  } catch {
    return [];
  }
}

export function clearAiSessionAttachmentDraft(draftKey: string) {
  return persistAiSessionAttachmentDraft(draftKey, []);
}

function revokeAttachmentPreviews(attachments: AiSessionComposerAttachment[]) {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function useAiSessionAttachmentDraft(
  draftKey: MaybeRefOrGetter<string>,
  options: { persistWhen?: () => boolean } = {},
) {
  const attachments = ref<AiSessionComposerAttachment[]>([]);
  let activeDraftKey = "";
  let revision = 0;
  let restoring = false;

  async function restore(nextDraftKey: string) {
    const restoreRevision = ++revision;
    activeDraftKey = nextDraftKey;
    restoring = true;
    revokeAttachmentPreviews(attachments.value);
    attachments.value = [];
    restoring = false;
    if (!nextDraftKey) return;

    const restored = await loadAiSessionAttachmentDraft(nextDraftKey);
    if (restoreRevision !== revision || activeDraftKey !== nextDraftKey || toValue(draftKey) !== nextDraftKey) {
      revokeAttachmentPreviews(restored);
      return;
    }
    restoring = true;
    attachments.value = restored;
    restoring = false;
  }

  watch(() => toValue(draftKey), (nextDraftKey) => {
    void restore(nextDraftKey);
  }, { immediate: true, flush: "sync" });

  watch(attachments, (nextAttachments) => {
    if (restoring) return;
    revision += 1;
    if (!activeDraftKey || activeDraftKey !== toValue(draftKey) || options.persistWhen?.() === false) return;
    void persistAiSessionAttachmentDraft(activeDraftKey, nextAttachments);
  }, { flush: "sync" });

  onScopeDispose(() => {
    revision += 1;
    activeDraftKey = "";
    revokeAttachmentPreviews(attachments.value);
  });

  return attachments;
}
