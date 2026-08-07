export function appSessionBindingKeys(session?: Record<string, unknown>) {
  const bindings = Array.isArray(session?.bindings) ? session.bindings : [];
  const normalized = bindings.flatMap((binding) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return [];
    const record = binding as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const id = typeof record.id === "string" ? record.id : "";
    if (!type || !id) return [];
    if (type === "app-session") return [`app:${id}`];
    if (type === "provider-session") return [`provider:${typeof record.agent === "string" ? record.agent : ""}:${id}`];
    if (type === "adapter-key") return [`adapter:${typeof record.adapter === "string" ? record.adapter : ""}:${typeof record.key === "string" ? record.key : id}`];
    return [];
  });
  const id = typeof session?.id === "string" ? session.id : "";
  const ai = session?.ai && typeof session.ai === "object" ? session.ai as Record<string, unknown> : undefined;
  const claude = ai?.claude && typeof ai.claude === "object" ? ai.claude as Record<string, unknown> : undefined;
  const claudeShort = typeof claude?.short === "string" ? claude.short : "";
  return [
    ...normalized,
    id ? `app:${id}` : "",
    claudeShort ? `adapter:claude:short:${claudeShort}` : "",
    claudeShort ? `claude-short:${claudeShort}` : "",
  ].filter(Boolean);
}

export function upsertAppSession<T extends Record<string, unknown>>(sessions: T[], session: T) {
  const index = sessions.findIndex((entry) => entry.id === session.id);
  if (index < 0) {
    return [...sessions, session];
  }
  return sessions.map((entry, currentIndex) => (currentIndex === index ? { ...entry, ...session } : entry));
}
