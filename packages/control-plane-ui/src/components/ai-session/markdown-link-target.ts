import type { RepositoryContext } from "@task-handoff/protocol/repository";
import { repositoryFileLocation } from "../../apps/control-plane/instance-detail/repositoryFilePath.ts";

export type MarkdownLinkTarget =
  | { kind: "file"; href: string; path: string; line?: number; column?: number }
  | { kind: "web"; href: string; url: string }
  | { kind: "unsupported"; href: string };

export function classifyMarkdownLink(href: string, context?: RepositoryContext): MarkdownLinkTarget {
  const raw = href.trim();
  if (!raw) return { kind: "unsupported", href };
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try {
      const url = new URL(raw);
      return { kind: "web", href: raw, url: url.toString() };
    } catch {
      return { kind: "unsupported", href: raw };
    }
  }
  if (scheme && scheme !== "file") return { kind: "unsupported", href: raw };
  if (!context) {
    if (raw.startsWith("/") || /^[a-z]:[\\/]/i.test(raw)) return { kind: "file", href: raw, path: raw.split(/[?#]/, 1)[0] || raw };
    if (scheme === "file") return { kind: "unsupported", href: raw };
    return { kind: "file", href: raw, path: raw.split(/[?#]/, 1)[0] || raw };
  }
  const location = repositoryFileLocation(raw, context);
  return location
    ? { kind: "file", href: raw, path: location.path, ...(location.line !== undefined ? { line: location.line } : {}), ...(location.column !== undefined ? { column: location.column } : {}) }
    : { kind: "unsupported", href: raw };
}
