export type AiSessionPathEntry = {
  cwd?: string;
  cwdFolderId?: string;
};

export type AiSessionPathEntryGroup<T extends AiSessionPathEntry> = {
  key: string;
  path: string;
  cwdFolderId?: string;
  entries: T[];
};

export type AiSessionPathFolder = {
  id: string;
  path: string;
};

export function normalizeAiSessionGroupPath(cwd: string | undefined) {
  const path = cwd?.trim() || "";
  if (!path || /^\/+$/u.test(path) || /^[A-Za-z]:[\\/]*$/u.test(path)) {
    return path;
  }
  return path.replace(/[\\/]+$/u, "");
}

export function groupAiSessionEntriesByPath<T extends AiSessionPathEntry>(
  entries: readonly T[],
  folders: readonly AiSessionPathFolder[] = [],
) {
  const groups = new Map<string, AiSessionPathEntryGroup<T>>();
  for (const entry of entries) {
    const path = normalizeAiSessionGroupPath(entry.cwd);
    const key = `cwd:${path}`;
    const current = groups.get(key);
    groups.set(key, {
      key,
      path,
      cwdFolderId: current?.cwdFolderId || entry.cwdFolderId,
      entries: [...(current?.entries || []), entry],
    });
  }
  for (const folder of folders) {
    const path = normalizeAiSessionGroupPath(folder.path);
    if (!path) continue;
    const key = `cwd:${path}`;
    const current = groups.get(key);
    groups.set(key, {
      key,
      path,
      cwdFolderId: current?.cwdFolderId || folder.id,
      entries: current?.entries || [],
    });
  }
  return [...groups.values()];
}
