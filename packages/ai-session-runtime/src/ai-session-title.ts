export const AI_SESSION_TITLE_MAX_CHARS = 36;
export const AI_SESSION_TITLE_PROMPT_MAX_BYTES = 960;

export const AI_SESSION_TITLE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: AI_SESSION_TITLE_MAX_CHARS,
    },
  },
  required: ["title"],
  additionalProperties: false,
};

export function aiSessionTitlePrompt(userPrompt: string) {
  const instructions = `Generate a concise, single-line task title of at most ${AI_SESSION_TITLE_MAX_CHARS} characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.`;
  const prefix = `${instructions}\n\nUser prompt:\n`;
  const remainingBytes = Math.max(0, AI_SESSION_TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
  return `${prefix}${truncateUtf8(userPrompt.trim(), remainingBytes)}`;
}

export function parseAiSessionTitle(response: string) {
  if (!response.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.title !== "string") return undefined;
  const normalized = record.title
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replace(/[.?!]+$/u, "")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, AI_SESSION_TITLE_MAX_CHARS).join("");
}

function truncateUtf8(value: string, maxBytes: number) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
