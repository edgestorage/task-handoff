import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
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
