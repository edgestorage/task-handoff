import type { JsonValue } from "./types";

export function asRecord(value: unknown): JsonValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonValue
    : {};
}

export function stringField(record: JsonValue, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
