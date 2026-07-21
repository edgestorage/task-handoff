import fs from "node:fs";
import { z } from "zod";
import { atomicWriteJsonSync } from "./atomic-write.ts";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export type DomainStoreOptions<T> = {
  schema: z.ZodType<T>;
  defaultValue: () => T;
  sanitize?: (value: unknown) => unknown;
};

export class DomainStore<T> {
  private readonly filePath: string;
  private readonly options: DomainStoreOptions<T>;

  constructor(
    filePath: string,
    options: DomainStoreOptions<T>,
  ) {
    this.filePath = filePath;
    this.options = options;
  }

  path() {
    return this.filePath;
  }

  load(): T {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return this.options.schema.parse(this.options.sanitize ? this.options.sanitize(raw) : raw);
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return this.options.defaultValue();
      }
      throw error;
    }
  }

  save(value: T) {
    atomicWriteJsonSync(this.filePath, this.options.schema.parse(value));
  }

  patch(patch: Record<string, unknown>) {
    const current = this.load();
    const next = mergePatch(JsonObjectSchema.parse(current), patch);
    const parsed = this.options.schema.parse(next);
    this.save(parsed);
    return parsed;
  }
}

function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const previous = next[key];
      next[key] = mergePatch(
        previous && typeof previous === "object" && !Array.isArray(previous) ? JsonObjectSchema.parse(previous) : {},
        JsonObjectSchema.parse(value),
      );
    } else if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}
