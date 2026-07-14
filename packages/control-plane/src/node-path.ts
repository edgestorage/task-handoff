import path from "node:path";

function isWindowsNodePath(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value);
}

function nodePathApi(value: string) {
  return isWindowsNodePath(value) ? path.win32 : path.posix;
}

export function resolveNodePath(value: string) {
  return nodePathApi(value).resolve(value);
}

export function relativeNodePathSegments(root: string, candidate: string): string[] | undefined {
  if (isWindowsNodePath(root) !== isWindowsNodePath(candidate)) {
    return undefined;
  }
  const nodePath = nodePathApi(root);
  const resolvedRoot = nodePath.resolve(root);
  const resolvedCandidate = nodePath.resolve(candidate);
  const relative = nodePath.relative(resolvedRoot, resolvedCandidate);
  if (!relative) {
    return [];
  }
  if (relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(nodePath.sep).filter(Boolean);
}
