import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(
  markedTerminal({
    reflowText: true,
    tab: 2,
  }),
);

export const color = {
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
  green: (text: string) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
  red: (text: string) => `\x1b[31m${text}\x1b[39m`,
};

export function box(title: string, lines: string[]) {
  const width = Math.max(title.length + 4, ...lines.map((line) => line.length + 4));
  const top = `╭${"─".repeat(width - 2)}╮`;
  const heading = `│ ${title}${" ".repeat(width - title.length - 3)}│`;
  const sep = `├${"─".repeat(width - 2)}┤`;
  const body = lines.map((line) => `│ ${line}${" ".repeat(width - line.length - 3)}│`);
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  return [top, heading, sep, ...body, bottom].join("\n");
}

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms >= 60 * 1000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export function renderMarkdown(value: unknown) {
  return String(marked(String(value))).trimEnd();
}
