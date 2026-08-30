import type { AiSessionMessageAttachmentRef } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionUploadedAttachment } from "../../api/types";
import type { AiSessionComposerAttachment } from "./AiSessionComposer.vue";

export async function uploadAiSessionComposerAttachment(
  attachment: AiSessionComposerAttachment,
  upload: (onProgress: (progress: number) => void) => Promise<AiSessionUploadedAttachment>,
): Promise<AiSessionMessageAttachmentRef> {
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
