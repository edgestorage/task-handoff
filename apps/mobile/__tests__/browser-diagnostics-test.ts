import { traceBrowserTask } from '../src/browser/diagnostics';
import { diagnosticLog } from '../src/observability/diagnostic-logs';

jest.mock('../src/observability/diagnostic-logs', () => ({
  diagnosticLog: { info: jest.fn(), warn: jest.fn() },
}));


beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); });
afterEach(() => jest.useRealTimers());

test('a stalled stage emits one correlated warning without completing or retrying the task', async () => {
  let finish!: (value: string) => void;
  const task = jest.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const pending = traceBrowserTask('browser.native.prepare', { instanceId: 'inst_1' }, task);
  jest.advanceTimersByTime(60_000);
  expect(task).toHaveBeenCalledTimes(1);
  expect(diagnosticLog.warn).toHaveBeenCalledTimes(1);
  const context = jest.mocked(diagnosticLog.info).mock.calls[0][1];
  expect(diagnosticLog.warn).toHaveBeenCalledWith('browser.native.prepare.waiting', expect.objectContaining({
    instanceId: 'inst_1', spanId: context?.spanId, durationMs: 10_000,
  }));
  finish('context_1');
  await expect(pending).resolves.toBe('context_1');
  expect(diagnosticLog.info).toHaveBeenLastCalledWith('browser.native.prepare.end', expect.objectContaining({ spanId: context?.spanId, outcome: 'completed' }));
  expect(jest.getTimerCount()).toBe(0);
});

test('failure retains the original error and logs its code without the sensitive message', async () => {
  const error = Object.assign(new Error('https://private.test/?token=private-credential'), { code: 'BROWSER_CHANNEL_CLOSED' });
  await expect(traceBrowserTask('browser.channel.open', {}, async () => { throw error; })).rejects.toBe(error);
  expect(diagnosticLog.warn).toHaveBeenCalledWith('browser.channel.open.end', expect.objectContaining({ outcome: 'failed', errorCode: 'BROWSER_CHANNEL_CLOSED' }));
  expect(JSON.stringify(jest.mocked(diagnosticLog.warn).mock.calls)).not.toContain('private-credential');
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(20_000);
  expect(diagnosticLog.warn).toHaveBeenCalledTimes(1);
});

test('a completed stage removes its slow warning deadline', async () => {
  await traceBrowserTask('browser.access.request', { instanceId: 'inst_1' }, async () => 'access');
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(20_000);
  expect(diagnosticLog.warn).not.toHaveBeenCalled();
});
