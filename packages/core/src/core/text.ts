export function normalizeCliMarkdown(value: unknown) {
  return String(value ?? "").replace(/\\n/g, "\n");
}
