import { canDisableTransport, transportEnabledCount } from '../src/remote-desktop/preferences';

test('at most two remote desktop transports can be disabled', () => {
  const all = { p2p: true, turn: true, websocket: true };
  expect(transportEnabledCount(all)).toBe(3);
  expect(canDisableTransport(all, 'p2p')).toBe(true);
  expect(canDisableTransport(all, 'turn')).toBe(true);
  expect(canDisableTransport(all, 'websocket')).toBe(true);

  const two = { p2p: true, turn: false, websocket: true };
  expect(canDisableTransport(two, 'p2p')).toBe(true);
  expect(canDisableTransport(two, 'websocket')).toBe(true);

  const one = { p2p: false, turn: false, websocket: true };
  expect(canDisableTransport(one, 'websocket')).toBe(false);
  expect(canDisableTransport(one, 'p2p')).toBe(true);
});
