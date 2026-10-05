import fs from "node:fs";
import { z } from "zod";
import { protocolError, usageError } from "../errors.ts";
import type { CliInvocation } from "../runtime.ts";
import { registerSecret } from "../redact.ts";

export function requireArgument(invocation: CliInvocation, name: string) {
  const value = invocation.args[name]?.trim();
  if (!value) throw usageError("CLI_ARGUMENT_MISSING", `Missing required argument <${name}>.`, { argument: name });
  return value;
}

export function optionString(invocation: CliInvocation, name: string) {
  const value = invocation.options[name];
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export function requireOption(invocation: CliInvocation, name: string) {
  const value = optionString(invocation, name);
  if (!value) throw usageError("CLI_OPTION_MISSING", `Missing required option --${name}.`, { option: name });
  return value;
}

export function repeatableOption(invocation: CliInvocation, name: string) {
  const value = invocation.options[name];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw usageError("CLI_INVALID_INPUT", `${label} does not match the expected schema.`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

/** 从文件读取 JSON；解析或校验失败都以用法错误返回，避免把本地输入错误映射成服务端错误。 */
export function readJsonFile<T>(file: string, schema: z.ZodType<T>, label: string) {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw usageError("CLI_FILE_UNREADABLE", `Cannot read ${label} \`${file}\`: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw usageError("CLI_FILE_INVALID_JSON", `${label} \`${file}\` is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  return parseWithSchema(schema, value, `${label} \`${file}\``);
}

/** 会话详情按当前 revision 读取时可能返回 not-modified；没有投影就无法继续，按协议异常处理。 */
export function requireUpdatedDetail<T>(
  detail: { kind: "updated"; detail: T } | { kind: "not-modified"; revision: string },
  sessionId: string,
) {
  if (detail.kind === "not-modified") {
    throw protocolError(`AI session \`${sessionId}\` is unchanged at revision ${detail.revision}; no projection is available locally.`, { sessionId, revision: detail.revision });
  }
  return detail.detail;
}

/**
 * 管理面写命令统一从 `--config <file>` 读取 JSON 请求体，避免密钥或复杂结构走明文选项；
 * 具体字段由服务端权威 schema 校验，客户端只保证是合法 JSON 对象。
 */
export function readRequestBody(invocation: CliInvocation, label = "request body") {
  const file = requireOption(invocation, "config");
  const value = readJsonFile(file, z.unknown(), label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError("CLI_INVALID_INPUT", `${label} \`${file}\` must be a JSON object.`, { file });
  }
  return value as Record<string, unknown>;
}

const STDIN_SECRET_LIMIT_BYTES = 1024 * 1024;

/**
 * 密钥只从 stdin 读取（`--token-stdin`），不接受明文选项或位置参数，
 * 避免 secret 进入 shell history、进程列表或 dry-run 输出。
 */
export async function readTokenFromStdin(invocation: CliInvocation) {
  if (invocation.options["token-stdin"] !== true) {
    throw usageError("CLI_TOKEN_STDIN_REQUIRED", "Provide the secret on stdin and re-run with --token-stdin.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > STDIN_SECRET_LIMIT_BYTES) {
      throw usageError("CLI_TOKEN_STDIN_TOO_LARGE", "The secret on stdin is too large.");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw usageError("CLI_TOKEN_STDIN_EMPTY", "No secret was provided on stdin.");
  registerSecret(value);
  return value;
}
