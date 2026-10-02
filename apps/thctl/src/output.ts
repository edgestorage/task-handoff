import { ThctlError } from "./errors.ts";
import { redactSecrets, redactText } from "./redact.ts";

export type CliColumn = {
  key: string;
  header: string;
  width?: number;
};

export type CliStreams = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export function defaultStreams(): CliStreams {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function valueAtPath(row: Record<string, unknown>, key: string): unknown {
  if (!key.includes(".")) return row[key];
  let current: unknown = row;
  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function cellValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.length ? value.map(cellValue).join(", ") : "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(value: string, width?: number) {
  if (!width || value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function renderTable(columns: readonly CliColumn[], rows: readonly Record<string, unknown>[]) {
  if (rows.length === 0) return "";
  const rendered = rows.map((row) => columns.map((column) => truncate(cellValue(valueAtPath(row, column.key)), column.width)));
  const widths = columns.map((column, index) => Math.max(
    column.header.length,
    ...rendered.map((row) => (row[index] ?? "").length),
  ));
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  return [line(columns.map((column) => column.header)), ...rendered.map(line)].join("\n");
}

export class CliOutput {
  readonly streams: CliStreams;
  json: boolean;

  constructor(streams: CliStreams, json: boolean) {
    this.streams = streams;
    this.json = json;
  }

  /** 数据只写 stdout；`--json` 输出与服务端 wire 模型一致，不做本地重命名。 */
  data(value: unknown, columns?: readonly CliColumn[]) {
    if (this.json) {
      this.streams.stdout(`${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    if (columns) {
      const rows = Array.isArray(value) ? value : [value];
      const table = renderTable(columns, rows as Record<string, unknown>[]);
      this.streams.stdout(table ? `${table}\n` : "\n");
      return;
    }
    this.streams.stdout(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  }

  message(text: string) {
    if (this.json) return;
    this.streams.stdout(`${text}\n`);
  }

  warn(text: string) {
    this.streams.stderr(`${redactText(text)}\n`);
  }

  error(error: ThctlError) {
    if (this.json) {
      this.streams.stderr(`${JSON.stringify({
        error: {
          code: error.code,
          message: redactText(error.message),
          ...(error.details ? { details: redactSecrets(error.details) } : {}),
        },
      })}\n`);
      return;
    }
    this.streams.stderr(`${error.code}: ${redactText(error.message)}\n`);
  }
}
