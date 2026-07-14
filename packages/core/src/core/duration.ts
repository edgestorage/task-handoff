import ms from "ms";

export function parseDuration(value: number | string) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("Duration must be a positive number.");
    }
    return value;
  }

  const input = String(value).trim();
  const duration = /^\d+(?:\.\d+)?$/.test(input) ? Number(input) : ms(input as ms.StringValue);
  if (typeof duration !== "number") {
    throw new Error("Duration must look like 300000, 30s, 5m, or 1h.");
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Duration must be a positive number.");
  }

  return Math.round(duration);
}
