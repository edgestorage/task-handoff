import telegramifyMarkdown from "telegramify-markdown";
import { renderAttachmentSummary } from "./attachments.ts";
import type { ChatPayload } from "./chat.ts";

function renderPlainChatPayload(payload: ChatPayload) {
  const lines = [payload.title];
  if (payload.timeoutLabel) {
    lines.push(`timeout: ${payload.timeoutLabel}`);
  }
  if (payload.body) {
    lines.push("", payload.body);
  }
  if (payload.instruction) {
    lines.push("", payload.instruction);
  }
  const attachmentSummary = renderAttachmentSummary(payload.attachments);
  if (attachmentSummary) {
    lines.push("", attachmentSummary);
  }
  return lines.join("\n");
}

function telegramMarkdownEscape(value: unknown) {
  return telegramifyMarkdown(String(value), "escape").replace(/\n+$/, "");
}

function renderTelegramProgressText(text: unknown) {
  const [heading, ...lines] = String(text).split("\n");
  return [`*${telegramMarkdownEscape(heading)}*`, ...lines.map(telegramMarkdownEscape)].join("\n");
}

function renderTelegramTitledPayload(payload: Pick<ChatPayload, "title" | "body">) {
  return [`*${telegramMarkdownEscape(payload.title)}*`, telegramMarkdownEscape(payload.body)].join("\n");
}

function renderTelegramApprovalText(text: unknown) {
  return String(text)
    .split("\n")
    .map((line) => {
      const match = line.match(/^(Codex 请求审批|权限请求审批|工具|权限|权限建议|目录|命令|原因)：(.*)$/);
      if (!match) {
        return telegramMarkdownEscape(line);
      }
      return `*${telegramMarkdownEscape(`${match[1]}：`)}*${telegramMarkdownEscape(match[2])}`;
    })
    .join("\n");
}

function renderTelegramApprovalPayload(payload: ChatPayload) {
  return renderTelegramApprovalText(payload.body);
}

function telegramMarkdownV2ToLegacy(value: unknown) {
  return String(value).replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
}

export {
  renderPlainChatPayload,
  renderTelegramApprovalPayload,
  renderTelegramApprovalText,
  renderTelegramProgressText,
  renderTelegramTitledPayload,
  telegramMarkdownEscape,
  telegramMarkdownV2ToLegacy,
};
