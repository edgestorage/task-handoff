import { REMOTE_DESKTOP_WHEEL_STEP, RemoteDesktopWheelPump } from '@task-handoff/control-plane-client';

test('wheel pump spreads a burst into one notch per drain', () => {
  const pump = new RemoteDesktopWheelPump();
  pump.add(100, -80);
  expect(pump.take()).toEqual({ x: REMOTE_DESKTOP_WHEEL_STEP, y: -REMOTE_DESKTOP_WHEEL_STEP });
  expect(pump.take()).toEqual({ x: REMOTE_DESKTOP_WHEEL_STEP, y: -REMOTE_DESKTOP_WHEEL_STEP });
  expect(pump.take()).toEqual({ x: 20, y: 0 });
  expect(pump.idle).toBe(true);
  expect(pump.take()).toBeUndefined();
});

test('wheel pump forwards sub-notch movement instead of discarding it', () => {
  const pump = new RemoteDesktopWheelPump();
  pump.add(12, -7);
  expect(pump.take()).toEqual({ x: 12, y: -7 });
  expect(pump.idle).toBe(true);

  pump.add(28, -33);
  expect(pump.take()).toEqual({ x: 28, y: -33 });
  expect(pump.idle).toBe(true);
});

test('wheel pump drops non-finite values and can be cleared between gestures', () => {
  const pump = new RemoteDesktopWheelPump();
  pump.add(Number.NaN, Number.POSITIVE_INFINITY);
  expect(pump.idle).toBe(true);
  pump.add(120, 120);
  pump.clear();
  expect(pump.idle).toBe(true);
});
