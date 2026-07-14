function parseJsonLine(line: string) {
  try {
    return JSON.parse(line) as AgentJsonlEvent;
  } catch {
    return undefined;
  }
}

type AgentMessagePart =
  | {
      type: "text";
      text?: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type AgentMessage = {
  type?: string;
  message?: string;
  content?: string | AgentMessagePart[];
  id?: string;
  session_id?: string;
  sessionId?: string;
  thread_id?: string;
  threadId?: string;
};

type AgentPayload = {
  type?: string;
  message?: string;
  namespace?: string;
  name?: string;
  id?: string;
  session_id?: string;
  sessionId?: string;
  thread_id?: string;
  threadId?: string;
  invocation?: {
    server?: string;
    tool?: string;
  };
};

type AgentJsonlEvent = {
  type?: string;
  result?: string;
  message?: string | AgentMessage;
  msg?: AgentMessage;
  thread_id?: string;
  threadId?: string;
  error?: {
    message?: string;
  };
  api_error_status?: string;
  is_error?: boolean;
  payload?: AgentPayload;
  session_id?: string;
  sessionId?: string;
  [key: string]: unknown;
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function findStringByKeys(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = findStringByKeys(item, keys);
      if (text) {
        return text;
      }
    }
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const text = stringValue(record[key]);
    if (text) {
      return text;
    }
  }
  for (const item of Object.values(record)) {
    const text = findStringByKeys(item, keys);
    if (text) {
      return text;
    }
  }
  return "";
}

function assistantJsonlText(event: AgentJsonlEvent | undefined) {
  const message = event?.message;
  const content = typeof message === "object" ? message.content : undefined;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part.type === "text" ? stringValue(part.text) : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function firstNonEmptyLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

export { assistantJsonlText, findStringByKeys, firstNonEmptyLine, parseJsonLine, stringValue };
