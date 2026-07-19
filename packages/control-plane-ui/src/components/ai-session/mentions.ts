import type { AiSessionMentionCandidate, AiSessionReference } from "@task-handoff/protocol/ai-sessions";

export type AiSessionMentionBinding = {
  id: string;
  token: string;
  start: number;
  end: number;
  reference: AiSessionReference;
};

export type AiSessionMentionToken = {
  start: number;
  end: number;
  query: string;
};

const STRUCTURED_KINDS = new Set(["plugin", "skill", "app"]);
const KIND_ORDER = new Map([
  ["plugin", 0],
  ["skill", 1],
  ["file", 2],
  ["directory", 3],
  ["app", 4],
]);

export function mentionTokenAt(value: string, cursor: number, trigger: string): AiSessionMentionToken | undefined {
  if (!trigger || cursor < 0 || cursor > value.length) return undefined;
  const start = value.lastIndexOf(trigger, cursor - 1);
  if (start < 0 || (start > 0 && !/\s/.test(value[start - 1] || ""))) return undefined;
  const beforeCursor = value.slice(start + trigger.length, cursor);
  if (/\s/.test(beforeCursor)) return undefined;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end] || "")) end += 1;
  return { start, end, query: beforeCursor };
}

export function reconcileMentionBindings(value: string, bindings: AiSessionMentionBinding[]) {
  const used = new Set<number>();
  return [...bindings]
    .sort((left, right) => left.start - right.start)
    .flatMap((binding) => {
      const starts: number[] = [];
      let from = 0;
      while (from <= value.length - binding.token.length) {
        const index = value.indexOf(binding.token, from);
        if (index < 0) break;
        if (!used.has(index)) starts.push(index);
        from = index + Math.max(1, binding.token.length);
      }
      if (!starts.length) return [];
      const start = starts.reduce((best, candidate) =>
        Math.abs(candidate - binding.start) < Math.abs(best - binding.start) ? candidate : best);
      used.add(start);
      return [{ ...binding, start, end: start + binding.token.length }];
    });
}

export function replaceMentionToken(input: {
  value: string;
  cursor: number;
  trigger: string;
  candidate: AiSessionMentionCandidate;
  bindings: AiSessionMentionBinding[];
}) {
  const active = mentionTokenAt(input.value, input.cursor, input.trigger);
  if (!active) return undefined;
  const structured = STRUCTURED_KINDS.has(input.candidate.kind);
  const token = structured ? `${input.trigger}${mentionLabel(input.candidate.name)}` : input.candidate.path;
  const needsSpace = active.end >= input.value.length || !/\s/.test(input.value[active.end] || "");
  const inserted = `${token}${needsSpace ? " " : ""}`;
  const value = `${input.value.slice(0, active.start)}${inserted}${input.value.slice(active.end)}`;
  const delta = inserted.length - (active.end - active.start);
  const retained = input.bindings.flatMap((binding) => {
    if (binding.end <= active.start) return [binding];
    if (binding.start >= active.end) return [{ ...binding, start: binding.start + delta, end: binding.end + delta }];
    return [];
  });
  if (structured) {
    retained.push({
      id: `mention_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      token,
      start: active.start,
      end: active.start + token.length,
      reference: {
        kind: input.candidate.kind as AiSessionReference["kind"],
        name: input.candidate.name,
        path: input.candidate.path,
      } as AiSessionReference,
    });
  }
  return { value, cursor: active.start + inserted.length, bindings: retained.sort((a, b) => a.start - b.start) };
}

export function referencesForBindings(value: string, bindings: AiSessionMentionBinding[]) {
  const references: AiSessionReference[] = [];
  const seen = new Set<string>();
  for (const binding of reconcileMentionBindings(value, bindings)) {
    const key = `${binding.reference.kind}\u0000${binding.reference.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push(binding.reference);
    }
  }
  return references;
}

export function sortMentionCandidates(candidates: AiSessionMentionCandidate[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return [...candidates]
    .filter((candidate) => !normalized || `${candidate.name}\n${candidate.description || ""}\n${candidate.path}`.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const kind = (KIND_ORDER.get(left.kind) || 0) - (KIND_ORDER.get(right.kind) || 0);
      return kind || left.name.localeCompare(right.name);
    });
}

function mentionLabel(name: string) {
  return name.trim().replace(/\s+/g, "-");
}
