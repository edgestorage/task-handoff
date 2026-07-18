import type { JsonValue } from "./types";

export function turnIdFromResult(result: JsonValue) {
  const turn = result.turn && typeof result.turn === "object"
    ? result.turn as JsonValue
    : undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}

export function isNoActiveTurnError(error: unknown) {
  return error instanceof Error && /no active turn/i.test(error.message);
}

export function activeTurnMismatchFoundId(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  return error.message.match(/expected active turn id `[^`]+` but found `([^`]+)`/i)?.[1];
}
