import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { RepositoryChanges, RepositoryContext, RepositoryDiff } from '@task-handoff/protocol/repository';
import { RepositoryResourceView } from '../src/repository/RepositoryResourceView';

const target = { instanceId: 'instance_1', sessionKind: 'ai-session' as const, sessionId: 'session_1' };
const listing = { path: '', snapshotId: 'snapshot_1', entries: [{ name: 'file.ts', path: 'file.ts', kind: 'file', traversable: false, editable: true }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a late response from an old session cannot overwrite the current repository', async () => {
  const old = deferred<typeof listing>();
  const directory = jest.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ ...listing, entries: [{ ...listing.entries[0], name: 'current.ts', path: 'current.ts' }] });
  const client = { repository: { directory } } as unknown as ControlPlaneClient;
  const props = { active: true, client, page: 'files' as const, ready: true };
  const screen = await render(<RepositoryResourceView {...props} target={target} workspaceIdentity="old" />);
  const oldSignal = directory.mock.calls[0][2].signal as AbortSignal;
  await screen.rerender(<RepositoryResourceView {...props} target={{ ...target, sessionId: 'session_2' }} workspaceIdentity="current" />);
  await waitFor(() => expect(screen.getByText('current.ts')).toBeTruthy());
  expect(oldSignal.aborted).toBe(true);
  await act(async () => old.resolve(listing));
  expect(screen.queryByText('file.ts')).toBeNull();
  expect(screen.getByText('current.ts')).toBeTruthy();
});

test('file navigation stays within the resource and uses explicit reads without a timer', async () => {
  const directory = jest.fn().mockResolvedValue(listing);
  const file = jest.fn().mockResolvedValue({ path: 'file.ts', content: 'hello resource', byteLength: 14, version: 'version_000000001', mode: { executable: false } });
  const client = { repository: { directory, file } } as unknown as ControlPlaneClient;
  const screen = await render(<RepositoryResourceView active client={client} page="files" ready target={target} workspaceIdentity="navigation-test" />);
  await waitFor(() => expect(screen.getByText('file.ts')).toBeTruthy());
  await fireEvent.press(screen.getByText('file.ts'));
  await waitFor(() => expect(screen.getByText('hello resource')).toBeTruthy());
  expect(file).toHaveBeenCalledWith(target, 'file.ts', expect.objectContaining({ signal: expect.anything() }));
  await fireEvent.press(screen.getByLabelText(/Back to list|返回列表/));
  await waitFor(() => expect(screen.getByText('file.ts')).toBeTruthy());
  expect(directory).toHaveBeenCalledTimes(2);
});

test('markdown file requests resolve against the authoritative repository context before reading', async () => {
  const context: RepositoryContext = {
    availability: 'available',
    sessionKind: 'ai-session',
    sessionId: 'session_1',
    observedAt: '2026-11-07T10:00:00.000Z',
    repositoryRoot: '/workspace/project',
    cwdRelativePath: 'packages/ui',
  };
  const repositoryContext = jest.fn().mockResolvedValue(context);
  const directory = jest.fn().mockResolvedValue(listing);
  const file = jest.fn().mockResolvedValue({ path: 'packages/spec.md', content: 'resolved file', byteLength: 13, version: 'version_000000001', mode: { executable: false } });
  const client = { repository: { context: repositoryContext, directory, file } } as unknown as ControlPlaneClient;
  const screen = await render(<RepositoryResourceView active client={client} fileRequest={{ href: '../spec.md:24', id: 1 }} page="files" ready target={target} workspaceIdentity="file-request-test" />);

  await waitFor(() => expect(screen.getByText('resolved file')).toBeTruthy());
  expect(repositoryContext).toHaveBeenCalledWith(target, expect.objectContaining({ signal: expect.anything() }));
  expect(file).toHaveBeenCalledWith(target, 'packages/spec.md', expect.objectContaining({ signal: expect.anything() }));
  expect(directory).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText(/Back to list|返回列表/));
  await waitFor(() => expect(directory).toHaveBeenCalledWith(target, 'packages', expect.objectContaining({ signal: expect.anything() })));
});


test('file selection survives a resource host remount without caching authoritative content', async () => {
  const directory = jest.fn().mockResolvedValue(listing);
  const file = jest.fn().mockResolvedValue({ path: 'file.ts', content: 'before remount', byteLength: 14, version: 'version_000000001', mode: { executable: false } });
  const client = { repository: { directory, file } } as unknown as ControlPlaneClient;
  const props = { active: true, client, page: 'files' as const, ready: true, target, workspaceIdentity: 'remount-test' };
  const first = await render(<RepositoryResourceView {...props} />);
  await waitFor(() => expect(first.getByText('file.ts')).toBeTruthy());
  await fireEvent.press(first.getByText('file.ts'));
  await waitFor(() => expect(first.getByText('before remount')).toBeTruthy());
  await first.unmount();
  file.mockResolvedValue({ path: 'file.ts', content: 'fresh after remount', byteLength: 19, version: 'version_000000002', mode: { executable: false } });
  const second = await render(<RepositoryResourceView {...props} />);
  await waitFor(() => expect(second.getByText('fresh after remount')).toBeTruthy());
  expect(directory).toHaveBeenCalledTimes(1);
  expect(file).toHaveBeenCalledTimes(2);
});

test('repository failures use localized copy instead of raw server messages and retry in place', async () => {
  const denied = Object.assign(new Error('Cloud access route is not available.'), { code: 'CLOUD_ROUTE_FORBIDDEN', status: 403 });
  const directory = jest.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce(listing);
  const client = { repository: { directory } } as unknown as ControlPlaneClient;
  const screen = await render(<RepositoryResourceView active client={client} page="files" ready target={target} workspaceIdentity="error-test" />);

  await waitFor(() => expect(screen.getByTestId('repository-error')).toBeTruthy());
  expect(screen.getByText('Read-only')).toBeTruthy();
  expect(screen.queryByText(/Cloud access route is not available/)).toBeNull();
  expect(screen.getByText(/doesn’t have access|无权查看/)).toBeTruthy();
  await fireEvent.press(screen.getByText(/Retry|重试/));
  await waitFor(() => expect(screen.getByText('file.ts')).toBeTruthy());
  expect(directory).toHaveBeenCalledTimes(2);
});

test('changes review renders web-style summary, scope filters, file cards and unified diff metadata', async () => {
  const context: RepositoryContext = {
    availability: 'available', sessionKind: 'ai-session', sessionId: 'session_1', observedAt: '2026-11-07T10:00:00.000Z',
    repositoryRoot: '/workspace/project', cwdRelativePath: '', displayName: 'project', head: { state: 'branch', branch: 'main' },
  };
  const changes: RepositoryChanges = {
    snapshotId: 'snapshot_1',
    summary: { conflicts: 0, staged: 1, unstaged: 1, untracked: 0 },
    entries: [
      { path: 'src/live.ts', scope: 'unstaged', status: 'modified', version: 'version_000000001', binary: false },
      { path: 'src/staged.ts', scope: 'staged', status: 'added', version: 'version_000000002', binary: false },
    ],
  };
  const diff: RepositoryDiff = {
    path: 'src/live.ts', scope: 'unstaged', binary: false, complete: true, truncated: false, byteLimit: 16_384, content: '', version: 'version_000000001', snapshotId: 'snapshot_1',
    lines: [
      { kind: 'hunk', content: '@@ -1,2 +1,2 @@', oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, hunkId: 'hunk:1' },
      { kind: 'context', content: 'const same = true', oldLine: 1, newLine: 1 },
      { kind: 'deletion', content: 'const value = 1', oldLine: 2 },
      { kind: 'addition', content: 'const value = 2', newLine: 2 },
    ],
    contextGaps: [],
  };
  const repositoryContext = jest.fn().mockResolvedValue(context);
  const repositoryChanges = jest.fn().mockResolvedValue(changes);
  const repositoryDiff = jest.fn().mockResolvedValue(diff);
  const client = { repository: { changes: repositoryChanges, context: repositoryContext, diff: repositoryDiff } } as unknown as ControlPlaneClient;
  const onOpenFile = jest.fn();
  const screen = await render(<RepositoryResourceView active client={client} onOpenFile={onOpenFile} onOpenFiles={jest.fn()} page="changes" ready target={target} workspaceIdentity="changes-review" />);

  await waitFor(() => expect(screen.getByText('src/live.ts')).toBeTruthy());
  expect(screen.getByText('2 changed files')).toBeTruthy();
  expect(screen.getByText('0 conflicts · 1 staged · 1 working')).toBeTruthy();
  expect(screen.getByText('project · main')).toBeTruthy();
  expect(screen.getByText(/Working tree · Modified/)).toBeTruthy();
  await waitFor(() => expect(repositoryDiff).toHaveBeenCalledWith(target, expect.objectContaining({ includeContext: true, path: 'src/live.ts', scope: 'unstaged' }), expect.objectContaining({ signal: expect.anything() })));
  const liveCard = screen.getByTestId('repository-change-unstaged:src/live.ts');
  const liveBody = screen.getByTestId('repository-change-body-unstaged:src/live.ts');
  await waitFor(() => expect(within(liveBody).getByTestId('repository-diff-addition')).toBeTruthy());
  expect(within(liveBody).getByText(/const value = 2/)).toBeTruthy();
  expect(screen.queryByTestId('repository-view-layout')).toBeNull();

  await fireEvent(screen.getByTestId('repository-changes-review'), 'layout', { nativeEvent: { layout: { height: 800, width: 1200, x: 0, y: 0 } } });
  expect(screen.getByTestId('repository-view-layout')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Show split diff'));
  await waitFor(() => expect(screen.getByTestId('repository-diff-new-addition')).toBeTruthy());
  expect(screen.queryByTestId('repository-diff-addition')).toBeNull();
  await fireEvent(screen.getByTestId('repository-changes-review'), 'layout', { nativeEvent: { layout: { height: 800, width: 430, x: 0, y: 0 } } });
  expect(screen.queryByTestId('repository-view-layout')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('repository-diff-addition')).toBeTruthy());

  await fireEvent.press(screen.getByTestId('repository-scope-staged'));
  await waitFor(() => expect(screen.queryByText('src/live.ts')).toBeNull());
  expect(screen.getByText('src/staged.ts')).toBeTruthy();

  await fireEvent.press(within(screen.getByTestId('repository-change-staged:src/staged.ts')).getByLabelText('Open files'));
  expect(onOpenFile).toHaveBeenCalledWith('src/staged.ts', '');
});

test('markdown files switch between rendered preview and source and route relative links through the file manager', async () => {
  const context: RepositoryContext = {
    availability: 'available', sessionKind: 'ai-session', sessionId: 'session_1', observedAt: '2026-11-07T10:00:00.000Z',
    repositoryRoot: '/workspace/project', cwdRelativePath: '',
  };
  const repositoryContext = jest.fn().mockResolvedValue(context);
  const file = jest.fn().mockResolvedValue({
    path: 'docs/README.md', content: '# Guide\n\n[Spec](../spec.md)\n', byteLength: 27, version: 'version_000000001', mode: { executable: false },
  });
  const client = { repository: { context: repositoryContext, file } } as unknown as ControlPlaneClient;
  const onOpenFile = jest.fn();
  const screen = await render(<RepositoryResourceView active client={client} fileRequest={{ href: 'docs/README.md', id: 1 }} onOpenFile={onOpenFile} page="files" ready target={target} workspaceIdentity="markdown-preview" />);

  await waitFor(() => expect(screen.getByTestId('repository-markdown-preview')).toBeTruthy());
  expect(screen.getByText('Guide')).toBeTruthy();
  await fireEvent.press(screen.getByText('Spec'));
  expect(onOpenFile).toHaveBeenCalledWith('../spec.md', 'docs');

  await fireEvent.press(screen.getByText('Source'));
  await waitFor(() => expect(screen.getByTestId('repository-source-preview')).toBeTruthy());
  await fireEvent.press(screen.getByText('Preview'));
  await waitFor(() => expect(screen.getByTestId('repository-markdown-preview')).toBeTruthy());
});

test('changed file picker follows scope and exposes the web directory tree interactions', async () => {
  const context: RepositoryContext = {
    availability: 'available', sessionKind: 'ai-session', sessionId: 'session_1', observedAt: '2026-11-07T10:00:00.000Z',
    repositoryRoot: '/workspace/project', cwdRelativePath: '', displayName: 'project', head: { state: 'branch', branch: 'main' },
  };
  const changes: RepositoryChanges = {
    snapshotId: 'snapshot_1',
    summary: { conflicts: 0, staged: 1, unstaged: 2, untracked: 0 },
    entries: [
      { path: 'docs/README.md', scope: 'unstaged', status: 'modified', version: 'version_000000001', binary: false },
      { path: 'src/live.ts', scope: 'unstaged', status: 'modified', version: 'version_000000002', binary: false },
      { path: 'src/nested/staged.ts', scope: 'staged', status: 'added', version: 'version_000000003', binary: false },
    ],
  };
  const diff: RepositoryDiff = {
    path: 'docs/README.md', scope: 'unstaged', binary: false, complete: true, truncated: false, byteLimit: 16_384, content: '', version: 'version_000000001', snapshotId: 'snapshot_1',
    lines: [], contextGaps: [],
  };
  const client = {
    repository: {
      changes: jest.fn().mockResolvedValue(changes),
      context: jest.fn().mockResolvedValue(context),
      diff: jest.fn().mockResolvedValue(diff),
    },
  } as unknown as ControlPlaneClient;
  const screen = await render(<RepositoryResourceView active client={client} page="changes" ready target={target} workspaceIdentity="changes-tree" />);

  await waitFor(() => expect(screen.getByText('docs/README.md')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Changed files'));
  expect(screen.getByTestId('repository-change-tree-directory:docs')).toBeTruthy();
  expect(screen.getByTestId('repository-change-tree-directory:src')).toBeTruthy();
  expect(screen.getByTestId('repository-change-tree-file:docs/README.md')).toBeTruthy();
  expect(screen.getByTestId('repository-change-tree-file:src/nested/staged.ts')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('repository-change-tree-directory:src'));
  expect(screen.queryByTestId('repository-change-tree-file:src/live.ts')).toBeNull();
  await fireEvent.press(screen.getByTestId('repository-change-tree-directory:src'));
  expect(screen.getByTestId('repository-change-tree-file:src/live.ts')).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText('Filter changed files…'), 'live');
  expect(screen.queryByTestId('repository-change-tree-directory:docs')).toBeNull();
  expect(screen.getByTestId('repository-change-tree-file:src/live.ts')).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText('Filter changed files…'), '');
  await fireEvent.press(screen.getAllByLabelText('Cancel')[0]);
  await fireEvent.press(screen.getByTestId('repository-scope-staged'));
  await fireEvent.press(screen.getByLabelText('Changed files'));
  expect(screen.getByTestId('repository-change-tree-file:src/nested/staged.ts')).toBeTruthy();
  expect(screen.queryByTestId('repository-change-tree-file:src/live.ts')).toBeNull();
});
