import type { RepositoryContext } from "@task-handoff/protocol/repository";

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeRelativePath(value: string) {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export type RepositoryFileLocation = {
  column?: number;
  line?: number;
  path: string;
};

function extractSourcePosition(value: string) {
  const fragmentMatch = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(value);
  if (fragmentMatch) {
    return {
      column: fragmentMatch[2] ? Number(fragmentMatch[2]) : undefined,
      line: Number(fragmentMatch[1]),
      path: value.slice(0, fragmentMatch.index),
    };
  }
  const suffixMatch = /:(\d+)(?::(\d+))?$/.exec(value);
  if (suffixMatch) {
    return {
      column: suffixMatch[2] ? Number(suffixMatch[2]) : undefined,
      line: Number(suffixMatch[1]),
      path: value.slice(0, suffixMatch.index),
    };
  }
  return { path: value };
}

export function repositoryFileLocation(href: string, context: RepositoryContext): RepositoryFileLocation | undefined {
  let path = href.trim();
  if (!path) return undefined;

  const position = extractSourcePosition(path);
  path = position.path;

  if (/^file:\/\//i.test(path)) {
    try {
      const fileUrl = new URL(path);
      path = fileUrl.hostname ? `//${fileUrl.hostname}${fileUrl.pathname}` : fileUrl.pathname;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return undefined;
    }
  } else {
    path = path.split(/[?#]/, 1)[0] || "";
  }
  path = decodePath(path).replaceAll("\\", "/");

  const repositoryRoot = context.repositoryRoot?.replaceAll("\\", "/").replace(/\/+$/, "");
  const absolute = path.startsWith("/") || /^[a-z]:\//i.test(path);
  if (absolute) {
    if (!repositoryRoot) return undefined;
    const caseInsensitive = /^[a-z]:\//i.test(repositoryRoot) || repositoryRoot.startsWith("//");
    const comparedPath = caseInsensitive ? path.toLowerCase() : path;
    const comparedRoot = caseInsensitive ? repositoryRoot.toLowerCase() : repositoryRoot;
    const withinRoot = comparedRoot === "/"
      ? comparedPath.startsWith("/")
      : comparedPath === comparedRoot || comparedPath.startsWith(`${comparedRoot}/`);
    if (!withinRoot) return undefined;
    path = comparedRoot === "/" ? path.slice(1) : path.slice(repositoryRoot.length).replace(/^\/+/, "");
  } else {
    path = [context.cwdRelativePath, path].filter(Boolean).join("/");
  }

  const normalizedPath = normalizeRelativePath(path);
  if (!normalizedPath) return undefined;
  return { ...position, path: normalizedPath };
}

export function repositoryRelativeFilePath(href: string, context: RepositoryContext) {
  return repositoryFileLocation(href, context)?.path;
}
