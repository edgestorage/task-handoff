import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export type DomainStoreOptions<T> = {
  schema: z.ZodType<T>;
  defaultValue: () => T;
};

export class DomainStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly options: DomainStoreOptions<T>,
  ) {}

  path() {
    return this.filePath;
  }

  load(): T {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return this.options.schema.parse(raw);
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return this.options.defaultValue();
      }
      throw error;
    }
  }

  save(value: T) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileAtomic.sync(this.filePath, `${JSON.stringify(this.options.schema.parse(value), null, 2)}\n`, { mode: 0o600 });
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
