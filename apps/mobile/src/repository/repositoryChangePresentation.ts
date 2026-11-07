import type { RepositoryChangeEntry } from '@task-handoff/protocol/repository';
import type { MessageKey } from '../i18n/messages';

export type ReviewScope = 'all' | 'working' | 'staged' | 'conflict';

export type ReviewTreeNode = {
  children: ReviewTreeNode[];
  depth: number;
  entries: RepositoryChangeEntry[];
  fileCount: number;
  key: string;
  kind: 'directory' | 'file';
  name: string;
  path: string;
};

export function reviewChangeKey(entry: RepositoryChangeEntry) {
  return `${entry.scope}:${entry.path}`;
}

export function matchesReviewScope(entry: RepositoryChangeEntry, scope: ReviewScope) {
  if (scope === 'all') return true;
  if (scope === 'working') return entry.scope === 'unstaged' || entry.scope === 'untracked';
  return entry.scope === scope;
}

export function compareReviewEntries(left: RepositoryChangeEntry, right: RepositoryChangeEntry) {
  const pathDelta = left.path.localeCompare(right.path);
  if (pathDelta) return pathDelta;
  const order = { conflict: 0, staged: 1, unstaged: 2, untracked: 3 } as const;
  return order[left.scope] - order[right.scope];
}

export function buildReviewTree(entries: readonly RepositoryChangeEntry[]) {
  const root: ReviewTreeNode = { children: [], depth: -1, entries: [], fileCount: 0, key: 'root', kind: 'directory', name: '', path: '' };
  const files = new Map<string, RepositoryChangeEntry[]>();
  for (const entry of entries) files.set(entry.path, [...(files.get(entry.path) || []), entry]);

  for (const [path, fileEntries] of files) {
    const segments = path.split('/').filter(Boolean);
    let parent = root;
    segments.forEach((segment, index) => {
      const nodePath = segments.slice(0, index + 1).join('/');
      const isFile = index === segments.length - 1;
      let node = parent.children.find((candidate) => candidate.name === segment && candidate.kind === (isFile ? 'file' : 'directory'));
      if (!node) {
        node = {
          children: [],
          depth: index,
          entries: isFile ? fileEntries : [],
          fileCount: isFile ? 1 : 0,
          key: `${isFile ? 'file' : 'directory'}:${nodePath}`,
          kind: isFile ? 'file' : 'directory',
          name: segment,
          path: nodePath,
        };
        parent.children.push(node);
      }
      parent = node;
    });
  }

  countTreeFiles(root);
  sortTreeNode(root);
  return root.children;
}

export function flattenReviewTree(nodes: readonly ReviewTreeNode[], collapsed: ReadonlySet<string> = new Set(), expandAll = false, result: ReviewTreeNode[] = []) {
  for (const node of nodes) {
    result.push(node);
    if (node.kind === 'directory' && (expandAll || !collapsed.has(node.path))) flattenReviewTree(node.children, collapsed, expandAll, result);
  }
  return result;
}

function countTreeFiles(node: ReviewTreeNode): number {
  if (node.kind === 'file') return 1;
  node.fileCount = node.children.reduce((total, child) => total + countTreeFiles(child), 0);
  return node.fileCount;
}

function sortTreeNode(node: ReviewTreeNode) {
  node.children.sort((left, right) => Number(left.kind === 'file') - Number(right.kind === 'file') || left.name.localeCompare(right.name));
  node.children.forEach(sortTreeNode);
}

export function scopeBadge(scope: RepositoryChangeEntry['scope']) {
  return ({ conflict: 'C', staged: 'S', unstaged: 'W', untracked: 'U' })[scope];
}

export function changeStatusMessageKey(status: RepositoryChangeEntry['status']): MessageKey {
  return `sessionResources.changeStatus.${status === 'type-changed' ? 'typeChanged' : status}`;
}

export function repositoryMarkdownBasePath(path: string) {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}
