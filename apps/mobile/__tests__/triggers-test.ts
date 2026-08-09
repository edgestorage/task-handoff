import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneTriggerTemplateInputSchema, type ControlPlaneTriggers } from '@task-handoff/protocol/triggers';

import { MobileTriggerController } from '../src/triggers/controller';
import { emptyTriggerDraft, triggerInput } from '../src/triggers/model';
import { MobileTriggerStore } from '../src/triggers/store';

const timestamp = '2026-08-09T00:00:00.000Z';
const emptySnapshot = (): ControlPlaneTriggers => ({ updatedAt: timestamp, triggers: [] });

describe('mobile triggers', () => {
  test('normalizes all source forms into the shared trigger contract', () => {
    const schedule = emptyTriggerDraft();
    schedule.name = 'Hourly';
    expect(ControlPlaneTriggerTemplateInputSchema.parse(triggerInput(schedule)).source).toEqual({ type: 'schedule', scheduleKind: 'interval', intervalMs: 3_600_000 });

    const files = emptyTriggerDraft();
    files.name = 'Docs'; files.sourceType = 'file-change'; files.roots = '/workspace, /workspace/docs'; files.globs = '**/*.md';
    expect(ControlPlaneTriggerTemplateInputSchema.parse(triggerInput(files)).source).toEqual(expect.objectContaining({ type: 'file-change', roots: ['/workspace', '/workspace/docs'], globs: ['**/*.md'] }));

    const sessions = emptyTriggerDraft();
    sessions.name = 'Failures'; sessions.sourceType = 'ai-session'; sessions.statuses = ['failed']; sessions.phases = ['approval'];
    expect(ControlPlaneTriggerTemplateInputSchema.parse(triggerInput(sessions)).source).toEqual({ type: 'ai-session', statuses: ['failed'], phases: ['approval'] });
  });

  test('loads role and snapshot and refreshes from trigger events', async () => {
    jest.useFakeTimers();
    let listCount = 0;
    const client = {
      auth: { session: async () => ({ authenticated: true, user: { role: 'operator' } }) },
      triggers: { list: async () => { listCount += 1; return emptySnapshot(); } },
    } as unknown as ControlPlaneClient;
    const store = new MobileTriggerStore();
    const controller = new MobileTriggerController('cp-1', client, store);
    await controller.start();
    expect(store.state('cp-1')).toEqual(expect.objectContaining({ phase: 'ready', canMutate: true }));
    expect(controller.applyEvent({ type: 'trigger.updated', topic: 'triggers' })).toBe(true);
    jest.advanceTimersByTime(100);
    await Promise.resolve();
    expect(listCount).toBe(2);
    controller.stop();
    jest.useRealTimers();
  });

  test('allows trigger mutations when control plane authentication is disabled', async () => {
    const client = {
      auth: { session: async () => ({ mode: 'disabled', enabled: false, requiresBootstrap: false, authenticated: true }) },
      triggers: { list: async () => emptySnapshot() },
    } as unknown as ControlPlaneClient;
    const store = new MobileTriggerStore();
    const controller = new MobileTriggerController('cp-disabled-auth', client, store);

    await controller.start();

    expect(store.state('cp-disabled-auth')).toEqual(expect.objectContaining({ phase: 'ready', canMutate: true }));
  });
});
