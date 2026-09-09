import type { AiSessionLineage, AiSessionLifecycle } from "./ai-sessions.ts";

export type AiSessionHierarchyRecord = {
  id: string;
  instanceId?: string;
  agent: string;
  providerSessionId?: string;
  lineage?: AiSessionLineage;
  status?: AiSessionLifecycle;
  lastUserMessageAt?: string;
  updatedAt: string;
  completedAt?: string;
};

export type AiSessionHierarchyDiagnosticCode =
  | "duplicate-provider-identity"
  | "orphan-parent"
  | "cross-agent-parent"
  | "cross-instance-parent"
  | "self-parent"
  | "cycle";

export type AiSessionHierarchyDiagnostic = {
  sessionId: string;
  code: AiSessionHierarchyDiagnosticCode;
  parentProviderSessionId?: string;
};

export type AiSessionTreeNode<T extends AiSessionHierarchyRecord> = {
  session: T;
  parentSessionId?: string;
  children: AiSessionTreeNode<T>[];
  aggregateUpdatedAt: string;
  aggregateLastActiveAt: string;
};

export type AiSessionForest<T extends AiSessionHierarchyRecord> = {
  roots: AiSessionTreeNode<T>[];
  nodesById: Map<string, AiSessionTreeNode<T>>;
  diagnostics: AiSessionHierarchyDiagnostic[];
};

export type AiSessionForestFilter = {
  visibleSessionIds: Set<string>;
  expandedSessionIds: Set<string>;
};

export type AiSessionTreeEntry<T extends AiSessionHierarchyRecord> = {
  node: AiSessionTreeNode<T>;
  depth: number;
};

export type AiSessionRetentionCandidate<T extends AiSessionHierarchyRecord> = {
  root: T;
  sessionIds: string[];
  lastActiveAt: string;
};

export type AiSessionForestOrder = "updated-at" | "last-user-message";

function identityKey(session: Pick<AiSessionHierarchyRecord, "instanceId" | "agent" | "providerSessionId">) {
  return `${session.instanceId || ""}\0${session.agent}\0${session.providerSessionId || ""}`;
}

function timestamp(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTimestamp(left: string, right: string) {
  return timestamp(right) > timestamp(left) ? right : left;
}

function stableHierarchyKey(session: AiSessionHierarchyRecord) {
  return [session.instanceId || "", session.agent, session.providerSessionId || session.id, session.id].join("\0");
}

function ownLastActiveAt(session: AiSessionHierarchyRecord) {
  return timestamp(session.completedAt) > timestamp(session.updatedAt)
    ? session.completedAt as string
    : session.updatedAt;
}

/** Derive a deterministic forest from a flat authoritative Session collection. */
export function deriveAiSessionForest<T extends AiSessionHierarchyRecord>(
  sessions: readonly T[],
  options: { orderBy?: AiSessionForestOrder } = {},
): AiSessionForest<T> {
  const diagnostics: AiSessionHierarchyDiagnostic[] = [];
  const nodes: AiSessionTreeNode<T>[] = sessions.map((session) => ({
    session,
    children: [],
    aggregateUpdatedAt: session.updatedAt,
    aggregateLastActiveAt: ownLastActiveAt(session),
  }));
  const nodesById = new Map(nodes.map((node) => [node.session.id, node]));
  const indexById = new Map(nodes.map((node, index) => [node.session.id, index]));
  const nodesByIdentity = new Map<string, AiSessionTreeNode<T>>();
  const nodesByProviderId = new Map<string, AiSessionTreeNode<T>[]>();

  for (const node of nodes) {
    if (!node.session.providerSessionId) continue;
    const key = identityKey(node.session);
    if (nodesByIdentity.has(key)) {
      diagnostics.push({ sessionId: node.session.id, code: "duplicate-provider-identity" });
    } else {
      nodesByIdentity.set(key, node);
    }
    const matches = nodesByProviderId.get(node.session.providerSessionId) || [];
    matches.push(node);
    nodesByProviderId.set(node.session.providerSessionId, matches);
  }

  const candidateParents = new Map<string, string>();
  for (const node of nodes) {
    const lineage = node.session.lineage;
    if (lineage?.kind !== "subagent") continue;
    const parent = nodesByIdentity.get(identityKey({
      instanceId: node.session.instanceId,
      agent: node.session.agent,
      providerSessionId: lineage.parentProviderSessionId,
    }));
    if (!parent) {
      const sameProvider = nodesByProviderId.get(lineage.parentProviderSessionId) || [];
      const code = sameProvider.some((candidate) => candidate.session.instanceId !== node.session.instanceId)
        ? "cross-instance-parent"
        : sameProvider.some((candidate) => candidate.session.agent !== node.session.agent)
          ? "cross-agent-parent"
          : "orphan-parent";
      diagnostics.push({ sessionId: node.session.id, code, parentProviderSessionId: lineage.parentProviderSessionId });
      continue;
    }
    if (parent.session.id === node.session.id) {
      diagnostics.push({ sessionId: node.session.id, code: "self-parent", parentProviderSessionId: lineage.parentProviderSessionId });
      continue;
    }
    candidateParents.set(node.session.id, parent.session.id);
  }

  const complete = new Set<string>();
  const cycleMembers = new Set<string>();
  for (const node of nodes) {
    if (complete.has(node.session.id)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = node.session.id;
    while (current && !complete.has(current)) {
      const seenAt = position.get(current);
      if (seenAt !== undefined) {
        for (const sessionId of path.slice(seenAt)) cycleMembers.add(sessionId);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = candidateParents.get(current);
    }
    for (const sessionId of path) complete.add(sessionId);
  }
  for (const sessionId of cycleMembers) {
    const node = nodesById.get(sessionId);
    candidateParents.delete(sessionId);
    diagnostics.push({
      sessionId,
      code: "cycle",
      parentProviderSessionId: node?.session.lineage?.parentProviderSessionId,
    });
  }

  const roots: AiSessionTreeNode<T>[] = [];
  for (const node of nodes) {
    const parentId = candidateParents.get(node.session.id);
    const parent = parentId ? nodesById.get(parentId) : undefined;
    if (!parent) {
      roots.push(node);
      continue;
    }
    node.parentSessionId = parent.session.id;
    parent.children.push(node);
  }

  const postorder: AiSessionTreeNode<T>[] = [];
  const stack = roots.map((node) => ({ node, visited: false }));
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.visited) {
      postorder.push(entry.node);
      continue;
    }
    stack.push({ node: entry.node, visited: true });
    for (const child of entry.node.children) stack.push({ node: child, visited: false });
  }
  for (const node of postorder) {
    for (const child of node.children) {
      node.aggregateUpdatedAt = latestTimestamp(node.aggregateUpdatedAt, child.aggregateUpdatedAt);
      node.aggregateLastActiveAt = latestTimestamp(node.aggregateLastActiveAt, child.aggregateLastActiveAt);
    }
    node.children.sort((left, right) => (
      hierarchyOrderTime(right, options.orderBy) - hierarchyOrderTime(left, options.orderBy)
      || hierarchyOrderFallback(left, right, options.orderBy, indexById)
    ));
  }
  roots.sort((left, right) => (
    hierarchyOrderTime(right, options.orderBy) - hierarchyOrderTime(left, options.orderBy)
    || hierarchyOrderFallback(left, right, options.orderBy, indexById)
  ));
  return { roots, nodesById, diagnostics };
}

function hierarchyOrderTime<T extends AiSessionHierarchyRecord>(
  node: AiSessionTreeNode<T>,
  orderBy: AiSessionForestOrder | undefined,
) {
  return timestamp(orderBy === "last-user-message" ? node.session.lastUserMessageAt : node.aggregateUpdatedAt);
}

function hierarchyOrderFallback<T extends AiSessionHierarchyRecord>(
  left: AiSessionTreeNode<T>,
  right: AiSessionTreeNode<T>,
  orderBy: AiSessionForestOrder | undefined,
  indexById: ReadonlyMap<string, number>,
) {
  return orderBy === "last-user-message"
    ? stableHierarchyKey(left.session).localeCompare(stableHierarchyKey(right.session))
    : (indexById.get(left.session.id) || 0) - (indexById.get(right.session.id) || 0);
}

export function aiSessionSubtreePostorder<T extends AiSessionHierarchyRecord>(
  forest: AiSessionForest<T>,
  sessionId: string,
): AiSessionTreeNode<T>[] {
  const root = forest.nodesById.get(sessionId);
  if (!root) return [];
  const ordered: AiSessionTreeNode<T>[] = [];
  const stack = [{ node: root, visited: false }];
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.visited) ordered.push(entry.node);
    else {
      stack.push({ node: entry.node, visited: true });
      for (const child of entry.node.children) stack.push({ node: child, visited: false });
    }
  }
  return ordered;
}

export function aiSessionRootNode<T extends AiSessionHierarchyRecord>(
  forest: AiSessionForest<T>,
  sessionId: string,
) {
  let node = forest.nodesById.get(sessionId);
  while (node?.parentSessionId) node = forest.nodesById.get(node.parentSessionId);
  return node;
}

export function countAiSessionRootTrees<T extends AiSessionHierarchyRecord>(forest: AiSessionForest<T>) {
  return forest.roots.filter((node) => node.session.lineage?.kind !== "subagent").length;
}

export function filterAiSessionForest<T extends AiSessionHierarchyRecord>(
  forest: AiSessionForest<T>,
  predicate: (session: T) => boolean,
): AiSessionForestFilter {
  const visibleSessionIds = new Set<string>();
  const expandedSessionIds = new Set<string>();
  for (const node of forest.nodesById.values()) {
    if (!predicate(node.session)) continue;
    visibleSessionIds.add(node.session.id);
    let current = node;
    while (current.parentSessionId) {
      const parent = forest.nodesById.get(current.parentSessionId);
      if (!parent) break;
      visibleSessionIds.add(parent.session.id);
      expandedSessionIds.add(parent.session.id);
      current = parent;
    }
  }
  return { visibleSessionIds, expandedSessionIds };
}

export function aiSessionAncestorIds<T extends AiSessionHierarchyRecord>(
  forest: AiSessionForest<T>,
  sessionId: string | undefined,
) {
  const ancestors: string[] = [];
  let node = sessionId ? forest.nodesById.get(sessionId) : undefined;
  while (node?.parentSessionId) {
    ancestors.push(node.parentSessionId);
    node = forest.nodesById.get(node.parentSessionId);
  }
  return ancestors;
}

export function flattenAiSessionForest<T extends AiSessionHierarchyRecord>(
  forest: AiSessionForest<T>,
  options: {
    expandedSessionIds?: ReadonlySet<string>;
    forcedExpandedSessionIds?: ReadonlySet<string>;
    visibleSessionIds?: ReadonlySet<string>;
  } = {},
): AiSessionTreeEntry<T>[] {
  const entries: AiSessionTreeEntry<T>[] = [];
  const stack = [...forest.roots].reverse().map((node) => ({ node, depth: 0 }));
  while (stack.length) {
    const entry = stack.pop()!;
    if (options.visibleSessionIds && !options.visibleSessionIds.has(entry.node.session.id)) continue;
    entries.push(entry);
    const expanded = options.expandedSessionIds?.has(entry.node.session.id)
      || options.forcedExpandedSessionIds?.has(entry.node.session.id);
    if (!expanded) continue;
    for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: entry.node.children[index], depth: entry.depth + 1 });
    }
  }
  return entries;
}

export function aiSessionRetentionCandidates<T extends AiSessionHierarchyRecord>(
  forest: AiSessionForest<T>,
  isIdle: (session: T) => boolean = (session) => session.status === "idle",
): AiSessionRetentionCandidate<T>[] {
  return forest.roots.flatMap((root) => {
    if (root.session.lineage?.kind === "subagent") return [];
    const nodes = aiSessionSubtreePostorder(forest, root.session.id);
    if (!nodes.every((node) => isIdle(node.session))) return [];
    return [{
      root: root.session,
      sessionIds: nodes.map((node) => node.session.id),
      lastActiveAt: root.aggregateLastActiveAt,
    }];
  }).sort((left, right) => timestamp(left.lastActiveAt) - timestamp(right.lastActiveAt));
}
