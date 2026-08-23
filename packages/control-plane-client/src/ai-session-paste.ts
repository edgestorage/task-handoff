import { AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES } from "@task-handoff/protocol/ai-sessions";

export const AI_SESSION_LONG_PASTE_CODE_POINT_THRESHOLD = 10_000;
export const AI_SESSION_PASTED_TEXT_SUMMARY_CODE_POINTS = 80;
// Provider-bound content is intentionally locale-neutral and must not use UI translation resources.
export const AI_SESSION_ATTACHMENT_ONLY_MESSAGE = "Please review the attached files.";

export type AiSessionPastedTextPresentation = {
  summary: string;
  codePointLength: number;
};

export type AiSessionPastedTextDecision =
  | { disposition: "inline" }
  | {
    disposition: "attachment";
    file: {
      name: string;
      mime: "text/plain";
      size: number;
      text: string;
      presentation: AiSessionPastedTextPresentation;
    };
  }
  | { disposition: "rejected"; code: "AI_SESSION_PASTED_TEXT_TOO_LARGE"; size: number };

export function aiSessionMessageText(message: string) {
  return message || AI_SESSION_ATTACHMENT_ONLY_MESSAGE;
}

export function normalizeAiSessionPastedText(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

export function aiSessionTextCodePointLength(text: string) {
  return [...text].length;
}

export function aiSessionPastedTextSummary(text: string) {
  const line = text.split("\n").map((candidate) => candidate.trim()).find(Boolean) || "";
  const compact = line.replace(/\s+/gu, " ");
  const codePoints = [...compact];
  return codePoints.length > AI_SESSION_PASTED_TEXT_SUMMARY_CODE_POINTS
    ? `${codePoints.slice(0, AI_SESSION_PASTED_TEXT_SUMMARY_CODE_POINTS).join("")}…`
    : compact;
}

export function classifyAiSessionPastedText(text: string, sequence = 1, maxFileAttachmentBytes = AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES): AiSessionPastedTextDecision {
  const normalized = normalizeAiSessionPastedText(text);
  const codePointLength = aiSessionTextCodePointLength(normalized);
  if (codePointLength <= AI_SESSION_LONG_PASTE_CODE_POINT_THRESHOLD) return { disposition: "inline" };
  const size = new TextEncoder().encode(normalized).byteLength;
  if (size >= maxFileAttachmentBytes) {
    return { disposition: "rejected", code: "AI_SESSION_PASTED_TEXT_TOO_LARGE", size };
  }
  return {
    disposition: "attachment",
    file: {
      name: `pasted-text-${Math.max(1, Math.trunc(sequence))}.txt`,
      mime: "text/plain",
      size,
      text: normalized,
      presentation: {
        summary: aiSessionPastedTextSummary(normalized),
        codePointLength,
      },
    },
  };
}
