import { STORY_CONTEXT_MAX_PROJECTS } from "@task-handoff/protocol/story-context";

type Project = { id: string; name: string; path: string };

export function projectChoices(folders: Project[], selected: string[], unavailable: string) {
  const catalog = new Map(folders.map((folder) => [folder.id, folder]));
  const linked = selected.map((id) => catalog.get(id) ?? { id, name: unavailable, path: id });
  const selectedIds = new Set(selected);
  return { linked, all: [...folders, ...linked.filter(({ id }) => !catalog.has(id))], selectedIds };
}

export function filterProjects(projects: Project[], search: string) {
  const term = search.trim().toLowerCase();
  return projects.filter(({ name, path }) => name.toLowerCase().includes(term) || path.toLowerCase().includes(term));
}

export function setProjectLinked(ids: string[], id: string, linked: boolean) {
  if (!linked) return ids.filter((candidate) => candidate !== id);
  return ids.includes(id) || ids.length >= STORY_CONTEXT_MAX_PROJECTS ? ids : [...ids, id];
}

export function moveLinkedProject(ids: string[], id: string, offset: -1 | 1) {
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
