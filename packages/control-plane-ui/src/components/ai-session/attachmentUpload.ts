import type { AiSessionMessageAttachmentRef, AiSessionQueuedMessage } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionUploadedAttachment } from "../../api/types";
import type { AiSessionComposerAttachment } from "./AiSessionComposer.vue";

export async function uploadAiSessionComposerAttachment(
  attachment: AiSessionComposerAttachment,
  upload: (onProgress: (progress: number) => void) => Promise<AiSessionUploadedAttachment>,
): Promise<AiSessionMessageAttachmentRef> {
  if (attachment.source.type === "retained") {
    throw new Error("Retained queue attachments cannot be uploaded again.");
  }
  if (attachment.source.type === "runtime-path") {
    return {
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      source: attachment.source,
    };
  }

  attachment.uploadState = "uploading";
  attachment.uploadProgress = 0;
  try {
    const uploaded = await upload((progress) => {
      attachment.uploadProgress = Math.max(0, Math.min(1, progress));
    });
    attachment.uploadProgress = 1;
    attachment.uploadState = "uploaded";
    return { id: uploaded.id, kind: uploaded.kind, source: { type: "upload-ref" } };
  } catch (error) {
    attachment.uploadState = "failed";
    throw error;
  }
}

export type AiSessionQueueEditAttachmentRef = AiSessionMessageAttachmentRef | {
  id: string;
  source: { type: "retained" };
};

export function queuedMessageComposerAttachments(
  instanceId: string,
  sessionId: string,
  item: AiSessionQueuedMessage,
): AiSessionComposerAttachment[] {
  return item.attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    source: { type: "retained" },
    ...(attachment.kind === "image" && item.messageId ? {
      previewUrl: `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(item.messageId)}/attachments/${encodeURIComponent(attachment.id)}/content`,
    } : {}),
  }));
}

export async function prepareQueuedMessageEditAttachments(
  attachments: AiSessionComposerAttachment[],
  upload: (attachment: AiSessionComposerAttachment) => Promise<AiSessionMessageAttachmentRef>,
): Promise<AiSessionQueueEditAttachmentRef[]> {
  return Promise.all(attachments.map((attachment) => attachment.source.type === "retained"
    ? Promise.resolve({ id: attachment.id, source: { type: "retained" as const } })
    : upload(attachment)));
}
