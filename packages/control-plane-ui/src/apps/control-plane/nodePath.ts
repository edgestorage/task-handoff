export type NodeFolderSelectionMode = "native" | "node";
export type NativeNodeFolderSelection = string | { path: string; ownerNodeId?: string } | undefined;
export type NativeNodeFolderSelectionResult =
  | { status: "cancelled" }
  | { status: "invalid-owner" }
  | { status: "selected"; path: string };

export function nodeFolderSelectionMode(isControlPlaneLocalNode: boolean, hasNativePicker: boolean): NodeFolderSelectionMode {
  return isControlPlaneLocalNode && hasNativePicker ? "native" : "node";
}

export function nativeNodeFolderSelectionResult(selection: NativeNodeFolderSelection, targetNodeId: string): NativeNodeFolderSelectionResult {
  if (!selection) return { status: "cancelled" };
  const path = (typeof selection === "string" ? selection : selection.path).trim();
  if (!path) return { status: "cancelled" };
  if (typeof selection !== "string" && selection.ownerNodeId && selection.ownerNodeId !== targetNodeId) {
    return { status: "invalid-owner" };
  }
  return { status: "selected", path };
}

function isWindowsNodePath(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(value);
}

type ComparableNodePath = {
  root: string;
  segments: string[];
};

export function nodePathName(value: string) {
  const nodePath = value.trim();
  if (!nodePath) {
    return "";
  }
  const withoutTrailingSeparators = nodePath.replace(/[\\/]+$/g, "");
  if (!withoutTrailingSeparators) {
    return nodePath;
  }
  const separator = isWindowsNodePath(nodePath) ? /[\\/]+/ : /\/+/;
  return withoutTrailingSeparators.split(separator).filter(Boolean).at(-1) || nodePath;
}

function comparableNodePath(value: string, windows: boolean): ComparableNodePath | undefined {
  const windowsSlashes = windows ? value.replace(/\\/g, "/") : "";
  const normalized = windows
    ? windowsSlashes.startsWith("//")
      ? `//${windowsSlashes.slice(2).replace(/\/+/g, "/")}`
      : windowsSlashes.replace(/\/+/g, "/")
    : value.replace(/\/+/g, "/");
  let root = "/";
  let remainder = normalized;

  if (windows) {
    const drive = normalized.match(/^([a-z]):\/(.*)$/i);
    const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (drive) {
      root = `${drive[1].toLowerCase()}:/`;
      remainder = drive[2];
    } else if (unc) {
      root = `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`;
      remainder = unc[3] || "";
    } else {
      return undefined;
    }
  } else if (normalized.startsWith("/")) {
    remainder = normalized.slice(1);
  } else {
    return undefined;
  }

  const segments: string[] = [];
  for (const rawSegment of remainder.split("/")) {
    const segment = windows ? rawSegment.toLowerCase() : rawSegment;
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { root, segments };
}

export function isSameOrChildNodePath(candidate: string, root: string) {
  const rootIsWindows = isWindowsNodePath(root);
  if (rootIsWindows !== isWindowsNodePath(candidate)) {
    return false;
  }
  const normalizedRoot = comparableNodePath(root, rootIsWindows);
  const normalizedCandidate = comparableNodePath(candidate, rootIsWindows);
  if (!normalizedRoot || !normalizedCandidate) {
    return false;
  }
  return normalizedCandidate.root === normalizedRoot.root
    && normalizedRoot.segments.every((segment, index) => normalizedCandidate.segments[index] === segment);
}
