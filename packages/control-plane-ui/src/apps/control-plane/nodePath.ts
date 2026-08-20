export type NodeFolderSelectionMode = "native" | "node";
export type NativeNodeFolderSelection = string | { path: string; ownerNodeId?: string } | undefined;
export type NativeNodeFolderPicker = () => Promise<NativeNodeFolderSelection>;
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

export type NodePathBreadcrumb = { label: string; path: string };

export function nodePathParent(value: string) {
  const nodePath = value.trim();
  if (!nodePath) return undefined;
  const windows = isWindowsNodePath(nodePath);
  const normalized = windows ? nodePath.replace(/\\/g, "/") : nodePath;
  const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}`;
    const segments = (unc[3] || "").split("/").filter(Boolean);
    return segments.length ? `${root}${segments.length > 1 ? `\\${segments.slice(0, -1).join("\\")}` : ""}` : undefined;
  }
  const driveRoot = normalized.match(/^([a-z]:)\/?$/i);
  if (normalized === "/" || driveRoot) return undefined;
  const withoutTrailing = normalized.replace(/\/+$/g, "");
  const separatorIndex = withoutTrailing.lastIndexOf("/");
  const parent = separatorIndex <= 0 ? "/" : withoutTrailing.slice(0, separatorIndex);
  if (!windows) return parent;
  const windowsParent = parent.match(/^[a-z]:$/i) ? `${parent}\\` : parent.replace(/\//g, "\\");
  return windowsParent;
}

export function nodePathBreadcrumbs(value: string): NodePathBreadcrumb[] {
  const nodePath = value.trim();
  if (!nodePath) return [];
  const windows = isWindowsNodePath(nodePath);
  const normalized = windows ? nodePath.replace(/\\/g, "/") : nodePath;
  const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}`;
    const segments = (unc[3] || "").split("/").filter(Boolean);
    return [
      { label: root, path: root },
      ...segments.map((segment, index) => ({ label: segment, path: `${root}\\${segments.slice(0, index + 1).join("\\")}` })),
    ];
  }
  const drive = normalized.match(/^([a-z]:)\/?(.*)$/i);
  if (drive) {
    const root = `${drive[1]}\\`;
    const segments = drive[2].split("/").filter(Boolean);
    return [
      { label: drive[1], path: root },
      ...segments.map((segment, index) => ({
        label: segment,
        path: `${drive[1]}\\${segments.slice(0, index + 1).join("\\")}`,
      })),
    ];
  }
  const segments = normalized.split("/").filter(Boolean);
  return [
    { label: "/", path: "/" },
    ...segments.map((segment, index) => ({ label: segment, path: `/${segments.slice(0, index + 1).join("/")}` })),
  ];
}

type ComparableNodePath = {
  root: string;
  segments: string[];
  comparisonSegments: string[];
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

export function nodeLocalFolderDisplayName(folder: { name?: string; path: string }) {
  return folder.name?.trim() || nodePathName(folder.path);
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
    const segment = rawSegment;
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return {
    root,
    segments,
    comparisonSegments: windows ? segments.map((segment) => segment.toLowerCase()) : segments,
  };
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
    && normalizedRoot.comparisonSegments.every((segment, index) => normalizedCandidate.comparisonSegments[index] === segment);
}

export function relativeNodePathSegments(root: string, candidate: string) {
  const rootIsWindows = isWindowsNodePath(root);
  if (rootIsWindows !== isWindowsNodePath(candidate)) {
    return undefined;
  }
  const normalizedRoot = comparableNodePath(root, rootIsWindows);
  const normalizedCandidate = comparableNodePath(candidate, rootIsWindows);
  if (!normalizedRoot || !normalizedCandidate || normalizedCandidate.root !== normalizedRoot.root) {
    return undefined;
  }
  if (!normalizedRoot.comparisonSegments.every((segment, index) => normalizedCandidate.comparisonSegments[index] === segment)) {
    return undefined;
  }
  return normalizedCandidate.segments.slice(normalizedRoot.segments.length);
}
