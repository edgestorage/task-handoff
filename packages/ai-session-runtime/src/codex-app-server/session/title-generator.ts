import type { AiSessionModelSelection, AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { CodexAppServerClientLike, CodexThreadStartOptions } from "../client/contract";
import type { CodexAppServerEvent, CodexThread, JsonValue } from "../protocol/types";

export const CODEX_THREAD_TITLE_MAX_CHARS = 36;
export const CODEX_THREAD_TITLE_PROMPT_MAX_BYTES = 960;

const TITLE_OUTPUT_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: CODEX_THREAD_TITLE_MAX_CHARS,
    },
  },
  required: ["title"],
  additionalProperties: false,
};

type CodexThreadTitleGeneratorOptions = {
  currentClient: () => CodexAppServerClientLike | undefined;
  findSession: (threadId: string) => AiSessionStatus | undefined;
  applyTitle: (threadId: string, title: string) => void;
  resolveModelSelection?: (
    selection: AiSessionModelSelection,
  ) => Pick<CodexThreadStartOptions, "model" | "modelProvider"> | undefined;
  onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
};

export class CodexThreadTitleGenerator {
  private connectionGeneration = 0;
  private readonly requestGeneration = new Map<string, number>();
  private readonly armedThreadIds = new Set<string>();

  constructor(private readonly options: CodexThreadTitleGeneratorOptions) {}

  arm(threadId: string) {
    this.armedThreadIds.add(threadId);
  }

  handle(event: CodexAppServerEvent) {
    if (
      event.type !== "user-message"
      || event.timelineItem?.status !== "completed"
      || !this.armedThreadIds.delete(event.threadId)
    ) return;
    const session = this.options.findSession(event.threadId);
    const client = this.options.currentClient();
    if (!session || !client) return;

    const connectionGeneration = this.connectionGeneration;
    const requestGeneration = this.nextRequestGeneration(event.threadId);
    void this.generate({
      client,
      connectionGeneration,
      requestGeneration,
      session,
      threadId: event.threadId,
      userPrompt: event.text,
    }).catch((error) => {
      this.options.onDiagnostic?.({
        code: "CODEX_THREAD_TITLE_GENERATION_FAILED",
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  cancel(threadId: string) {
    this.armedThreadIds.delete(threadId);
    this.nextRequestGeneration(threadId);
  }

  resetConnection() {
    this.connectionGeneration += 1;
    this.requestGeneration.clear();
    this.armedThreadIds.clear();
  }

  private async generate(input: {
    client: CodexAppServerClientLike;
    connectionGeneration: number;
    requestGeneration: number;
    session: AiSessionStatus;
    threadId: string;
    userPrompt: string;
  }) {
    const { client, session, threadId } = input;
    if (!client.readThread || !client.runEphemeralStructuredTurn) {
      this.options.onDiagnostic?.({
        code: "CODEX_THREAD_TITLE_GENERATION_UNSUPPORTED",
        threadId,
      });
      return;
    }

    const initial = await client.readThread(threadId, { includeTurns: false });
    if (!this.isCurrent(input) || !initial || session.title?.trim()) return;
    const selected = this.selectedModel(initial, session);
    if (!selected) {
      this.options.onDiagnostic?.({
        code: "CODEX_THREAD_TITLE_MODEL_UNRESOLVED",
        threadId,
        modelSelection: session.modelSelection,
      });
      return;
    }
    const cwd = nonemptyString(initial.cwd) || nonemptyString(session.cwd);
    if (!cwd) {
      this.options.onDiagnostic?.({
        code: "CODEX_THREAD_TITLE_CWD_UNRESOLVED",
        threadId,
      });
      return;
    }

    const response = await client.runEphemeralStructuredTurn({
      cwd,
      model: selected.model,
      modelProvider: selected.modelProvider,
      prompt: codexThreadTitlePrompt(input.userPrompt),
      outputSchema: TITLE_OUTPUT_SCHEMA,
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
    });
    const title = parseCodexThreadTitle(response);
    if (!title) throw new Error("Codex returned an invalid structured thread title.");
    if (!this.isCurrent(input)) return;

    const latest = this.options.findSession(threadId);
    if (!this.isCurrent(input) || !latest || latest.title?.trim()) return;
    this.options.applyTitle(threadId, title);
  }

  private selectedModel(thread: CodexThread, session: AiSessionStatus) {
    if (session.modelSelection) {
      const resolved = this.options.resolveModelSelection?.(session.modelSelection);
      const resolvedModel = nonemptyString(resolved?.model);
      const resolvedProvider = nonemptyString(resolved?.modelProvider);
      return resolvedModel && resolvedProvider
        ? { model: resolvedModel, modelProvider: resolvedProvider }
        : undefined;
    }
    const model = nonemptyString(thread.model);
    const modelProvider = nonemptyString(thread.modelProvider);
    return model && modelProvider ? { model, modelProvider } : undefined;
  }

  private isCurrent(input: {
    client: CodexAppServerClientLike;
    connectionGeneration: number;
    requestGeneration: number;
    threadId: string;
  }) {
    return input.client === this.options.currentClient()
      && input.connectionGeneration === this.connectionGeneration
      && input.requestGeneration === this.requestGeneration.get(input.threadId);
  }

  private nextRequestGeneration(threadId: string) {
    const generation = (this.requestGeneration.get(threadId) || 0) + 1;
    this.requestGeneration.set(threadId, generation);
    return generation;
  }
}

export function codexThreadTitlePrompt(userPrompt: string) {
  const instructions = `Generate a concise, single-line task title of at most ${CODEX_THREAD_TITLE_MAX_CHARS} characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.`;
  const prefix = `${instructions}\n\nUser prompt:\n`;
  const remainingBytes = Math.max(0, CODEX_THREAD_TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
  return `${prefix}${truncateUtf8(userPrompt.trim(), remainingBytes)}`;
}

export function parseCodexThreadTitle(response: string) {
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
  return Array.from(normalized).slice(0, CODEX_THREAD_TITLE_MAX_CHARS).join("");
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

function nonemptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
