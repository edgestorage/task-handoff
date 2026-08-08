import { MobileMetrics } from '../src/observability/mobile-metrics';

test('mobile metrics are bounded and drop identities, secrets, paths, and message bodies', () => {
  const metrics = new MobileMetrics();
  metrics.record('action.error', {
    action: 'send', result: 'unknown', controlPlaneId: 'cp-secret', sessionId: 'session-secret',
    message: 'private body', path: '/workspace/private', token: 'bearer-secret',
  });
  const serialized = JSON.stringify(metrics.snapshot());
  expect(serialized).toContain('send');
  expect(serialized).toContain('unknown');
  expect(serialized).not.toMatch(/cp-secret|session-secret|private body|workspace|bearer-secret/);
  for (let index = 0; index < 510; index += 1) metrics.record('render.duration', { screen: 'detail' }, index);
  expect(metrics.snapshot()).toHaveLength(500);
});
