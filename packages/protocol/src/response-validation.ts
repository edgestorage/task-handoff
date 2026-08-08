import { z } from "zod";

type UnknownKeyIssue = {
  code: "unrecognized_keys";
  keys: string[];
  path: PropertyKey[];
};

type NestedIssue = {
  code: string;
  errors?: unknown;
};

/**
 * Parses data received from another process or service without treating fields
 * introduced by a newer producer as a protocol failure. Declared fields remain
 * fully validated, including required-field and type checks.
 */
export function safeParseResponse<S extends z.ZodType>(schema: S, input: unknown): z.ZodSafeParseResult<z.output<S>> {
  let candidate = cloneResponseValue(input);
  for (let pass = 0; pass < 100; pass += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed;
    const unknownKeys = collectUnknownKeyIssues(parsed.error.issues);
    let changed = false;
    for (const issue of unknownKeys) {
      const parent = valueAtPath(candidate, issue.path);
      if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
      for (const key of issue.keys) {
        if (!Object.prototype.hasOwnProperty.call(parent, key)) continue;
        delete (parent as Record<string, unknown>)[key];
        changed = true;
      }
    }
    if (!changed) return parsed;
  }
  return schema.safeParse(candidate);
}

export function parseResponse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = safeParseResponse(schema, input);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/** Wraps an existing schema so transports using parse/safeParse get the same policy. */
export function responseSchema<S extends z.ZodType>(schema: S): z.ZodType<z.output<S>> {
  return z.unknown().transform((input, context) => {
    const parsed = safeParseResponse(schema, input);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  }) as z.ZodType<z.output<S>>;
}

function collectUnknownKeyIssues(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): UnknownKeyIssue[] {
  const collected: UnknownKeyIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      collected.push({
        code: "unrecognized_keys",
        keys: issue.keys,
        path: [...prefix, ...issue.path],
      });
      continue;
    }
    if (issue.code !== "invalid_union" || !Array.isArray((issue as NestedIssue).errors)) continue;
    const alternatives = ((issue as NestedIssue).errors as unknown[])
      .filter((entry): entry is z.core.$ZodIssue[] => Array.isArray(entry));
    if (!alternatives.length) continue;
    const best = alternatives.reduce((current, alternative) => (
      nonUnknownIssueCount(alternative) < nonUnknownIssueCount(current) ? alternative : current
    ));
    collected.push(...collectUnknownKeyIssues(best, [...prefix, ...issue.path]));
  }
  return collected;
}

function nonUnknownIssueCount(issues: readonly z.core.$ZodIssue[]): number {
  return issues.reduce((count, issue) => {
    if (issue.code === "unrecognized_keys") return count;
    if (issue.code !== "invalid_union" || !Array.isArray((issue as NestedIssue).errors)) return count + 1;
    const alternatives = ((issue as NestedIssue).errors as unknown[])
      .filter((entry): entry is z.core.$ZodIssue[] => Array.isArray(entry));
    return count + (alternatives.length ? Math.min(...alternatives.map(nonUnknownIssueCount)) : 1);
  }, 0);
}

function valueAtPath(input: unknown, path: readonly PropertyKey[]) {
  let current = input;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function cloneResponseValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(cloneResponseValue);
  if (!input || typeof input !== "object") return input;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cloneResponseValue(value)]));
}
