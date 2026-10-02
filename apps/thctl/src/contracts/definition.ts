import { z } from "zod";
import type { CliHandler } from "../runtime.ts";

export type CliArgument = {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
};

export type CliOption = {
  flags: string;
  description: string;
  repeatable?: boolean;
};

export type CliStage = "A" | "B" | "C";

export type CliLeaf = {
  id: string;
  group: string;
  name: string;
  summary: string;
  stage: CliStage;
  args?: readonly CliArgument[];
  options?: readonly CliOption[];
  /** CLI 参数与选项的输入契约；`thctl schema` 用它导出 JSON Schema。 */
  input: z.ZodType;
  /** 服务端 wire 模型输出契约；`outputPinned` 为 false 表示阶段实现时才收窄。 */
  output: z.ZodType;
  outputPinned?: boolean;
  /** `json-lines` 表示命令持续输出多行 JSON，而非单个文档。 */
  outputMode?: "document" | "json-lines";
  examples?: readonly string[];
  write?: boolean;
  handler?: CliHandler;
};

export type CliGroup = {
  name: string;
  summary: string;
  /** flat 分组直接注册在根命令下（如 `thctl login`），不生成同名父命令。 */
  flat?: boolean;
  leaves: readonly CliLeaf[];
};

export const looseOutput = z.looseObject({});
export const emptyInput = z.object({}).strict();

export function inputOf(properties: Record<string, z.ZodType>) {
  return z.object(properties).strict();
}

export function group(name: string, summary: string, leaves: readonly CliLeaf[], options: { flat?: boolean } = {}): CliGroup {
  return { name, summary, leaves, ...(options.flat ? { flat: true } : {}) };
}

export function leafId(group: string, name: string) {
  return `${group} ${name}`;
}
