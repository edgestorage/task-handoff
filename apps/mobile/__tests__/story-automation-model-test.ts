import { StoryAutomationStatusSchema, StorySchema } from '@task-handoff/protocol/stories';

import { storyAutomationCreateInput, storyAutomationDraft, storyAutomationDraftValid, storyAutomationDraftWithActionValid, storyAutomationUpdateInput, storyAutomationWithActionInput } from '../src/stories/story-automation-model';

const story = StorySchema.parse({
  id: 'story-1', ownerNodeId: 'node-1', title: 'Release', documents: [],
  actions: [{ id: 'deploy', title: 'Deploy', promptTemplate: 'Deploy now', targetInstanceId: 'instance-1' }],
  createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
});

test('creates a valid mobile Automation payload from the selected Action', () => {
  const draft = storyAutomationDraft(story);
  expect(storyAutomationDraftValid(draft, story)).toBe(true);
  expect(storyAutomationCreateInput(draft, story.id)).toEqual(expect.objectContaining({
    storyId: story.id,
    actionId: 'deploy',
    schedule: { scheduleKind: 'interval', intervalMs: 3_600_000 },
  }));
});

test('Automation updates do not resend immutable Story and Action ownership', () => {
  const status = StoryAutomationStatusSchema.parse({
    automation: { id: 'automation-1', storyId: story.id, actionId: 'deploy', schedule: { scheduleKind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' }, enabled: true, policy: { maxConcurrentRuns: 2, whenBusy: 'queue', cooldownMs: 60_000 }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
    effectiveStatus: 'scheduled', currentRuns: [],
  });
  const input = storyAutomationUpdateInput(storyAutomationDraft(story, status));
  expect(input).toEqual(expect.objectContaining({ schedule: status.automation.schedule, policy: status.automation.policy }));
  expect(input).not.toHaveProperty('storyId');
  expect(input).not.toHaveProperty('actionId');
});

test('new Action remains a draft until the combined Automation command is built', () => {
  const draft = { ...storyAutomationDraft(story), actionId: '' };
  const action = { id: 'draft-action', title: 'Verify', promptTemplate: 'Verify release', targetInstanceId: 'instance-1' };
  expect(storyAutomationDraftWithActionValid(draft, story, action)).toBe(true);
  expect(story.actions).toHaveLength(1);
  expect(storyAutomationWithActionInput(draft, action)).toEqual({
    action,
    automation: expect.objectContaining({ schedule: { scheduleKind: 'interval', intervalMs: 3_600_000 } }),
  });
});
