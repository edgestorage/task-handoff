import type { ComputedRef, InjectionKey } from "vue";
import type { MarkdownCodeTools } from "@task-handoff/web-theme/markdown";

export const defaultAiSessionMarkdownCodeTools: MarkdownCodeTools = {
  copiedLabel: "Copied",
  copyLabel: "Copy",
  plainTextLabel: "Plain text",
};

export const aiSessionMarkdownCodeToolsKey: InjectionKey<ComputedRef<MarkdownCodeTools>> = Symbol("aiSessionMarkdownCodeTools");
