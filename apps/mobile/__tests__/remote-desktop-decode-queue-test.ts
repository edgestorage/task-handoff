import { RemoteDesktopDecodeQueue } from '../src/remote-desktop/decode-queue';

const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };

test('decoder overload drops the pending group, preserves a single active call and invalidates its completion', async () => {
  const queue = new RemoteDesktopDecodeQueue(3, 100);
  let release!: () => void;
  let current = true;
  const active = jest.fn(async (isCurrent: () => boolean) => {
    await new Promise<void>(resolve => { release = resolve; });
    current = isCurrent();
  });
  const stale = jest.fn(async () => {});
  const fresh = jest.fn(async () => {});
  expect(queue.enqueue({ bytes: 10, run: active })).toBe(true);
  expect(queue.enqueue({ bytes: 10, run: stale })).toBe(true);
  expect(queue.enqueue({ bytes: 10, run: stale })).toBe(true);
  expect(queue.size).toBe(3);
  expect(queue.enqueue({ bytes: 10, run: stale })).toBe(false);
  expect(queue.size).toBe(1);
  expect(queue.bufferedBytes).toBe(10);
  expect(queue.enqueue({ bytes: 10, run: fresh })).toBe(true);
  expect(fresh).not.toHaveBeenCalled();
  release();
  await tick();
  expect(current).toBe(false);
  expect(stale).not.toHaveBeenCalled();
  expect(fresh).toHaveBeenCalledTimes(1);
  expect(queue.size).toBe(0);
  expect(queue.bufferedBytes).toBe(0);
});

test('compressed byte capacity is bounded independently of the frame count', async () => {
  const queue = new RemoteDesktopDecodeQueue(8, 32);
  let release!: () => void;
  queue.enqueue({ bytes: 16, run: () => new Promise<void>(resolve => { release = resolve; }) });
  expect(queue.enqueue({ bytes: 17, run: async () => {} })).toBe(false);
  expect(queue.bufferedBytes).toBe(16);
  release();
  await tick();
  expect(queue.size).toBe(0);
});

test('reset removes old-session jobs without running another native decode concurrently', async () => {
  const queue = new RemoteDesktopDecodeQueue();
  let release!: () => void;
  queue.enqueue({ bytes: 10, run: () => new Promise<void>(resolve => { release = resolve; }) });
  const stale = jest.fn(async () => {});
  const next = jest.fn(async () => {});
  queue.enqueue({ bytes: 10, run: stale });
  queue.clear();
  queue.enqueue({ bytes: 10, run: next });
  expect(next).not.toHaveBeenCalled();
  release();
  await tick();
  expect(stale).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledTimes(1);
});
