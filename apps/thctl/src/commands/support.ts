import fs from "node:fs";
import { z } from "zod";
import { protocolError, usageError } from "../errors.ts";
import type { CliInvocation } from "../runtime.ts";

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
