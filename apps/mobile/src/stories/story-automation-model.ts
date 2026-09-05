import type {
  Story,
  StoryAction,
  StoryAutomationInput,
  StoryAutomationSchedule,
  StoryAutomationStatus,
  StoryAutomationUpdateInput,
  StoryAutomationWithActionInput,
} from '@task-handoff/protocol/stories';

export type StoryAutomationDraft = {
  actionId: string;
  cooldownMinutes: string;
  enabled: boolean;
  intervalMinutes: string;
  maxConcurrentRuns: string;
  scheduleKind: StoryAutomationSchedule['scheduleKind'];
  timeOfDay: string;
  timezone: string;
  weekdays: number[];
  whenBusy: 'skip' | 'queue';
};

export function storyAutomationDraft(story: Story, status?: StoryAutomationStatus): StoryAutomationDraft {
  const schedule = status?.automation.schedule;
  return {
    actionId: status?.automation.actionId || story.actions.find((action) => action.targetInstanceId)?.id || '',
    cooldownMinutes: String((status?.automation.policy.cooldownMs || 0) / 60_000),
    enabled: status?.automation.enabled ?? true,
    intervalMinutes: schedule?.scheduleKind === 'interval' ? String(schedule.intervalMs / 60_000) : '60',
    maxConcurrentRuns: String(status?.automation.policy.maxConcurrentRuns || 1),
    scheduleKind: schedule?.scheduleKind || 'interval',
    timeOfDay: schedule && schedule.scheduleKind !== 'interval' ? schedule.timeOfDay : '09:00',
    timezone: schedule && schedule.scheduleKind !== 'interval' ? schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    weekdays: schedule?.scheduleKind === 'weekly' ? [...schedule.weekdays] : [1],
    whenBusy: status?.automation.policy.whenBusy || 'skip',
  };
}

export function storyAutomationDraftValid(draft: StoryAutomationDraft, story: Story) {
  const action = story.actions.find((candidate) => candidate.id === draft.actionId && candidate.targetInstanceId);
  const maxConcurrentRuns = Number(draft.maxConcurrentRuns);
  const cooldownMinutes = Number(draft.cooldownMinutes);
  if (!action || !Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 20) return false;
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 1_440) return false;
  if (draft.scheduleKind === 'interval') {
    const intervalMinutes = Number(draft.intervalMinutes);
    return Number.isFinite(intervalMinutes) && intervalMinutes >= 1;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay) || !draft.timezone.trim()) return false;
  return draft.scheduleKind !== 'weekly' || draft.weekdays.length > 0;
}

export function storyAutomationDraftWithActionValid(draft: StoryAutomationDraft, story: Story, action: StoryAction) {
  return storyAutomationDraftValid({ ...draft, actionId: action.id }, { ...story, actions: [...story.actions, action] });
}

function scheduleInput(draft: StoryAutomationDraft): StoryAutomationSchedule {
  if (draft.scheduleKind === 'interval') return { scheduleKind: 'interval', intervalMs: Math.round(Number(draft.intervalMinutes) * 60_000) };
  if (draft.scheduleKind === 'daily') return { scheduleKind: 'daily', timeOfDay: draft.timeOfDay, timezone: draft.timezone.trim() };
  return { scheduleKind: 'weekly', weekdays: [...new Set(draft.weekdays)].sort(), timeOfDay: draft.timeOfDay, timezone: draft.timezone.trim() };
}

function mutableInput(draft: StoryAutomationDraft): StoryAutomationWithActionInput['automation'] {
  const cooldownMs = Math.round(Number(draft.cooldownMinutes) * 60_000);
  return {
    enabled: draft.enabled,
    policy: {
      maxConcurrentRuns: Number(draft.maxConcurrentRuns),
      whenBusy: draft.whenBusy,
      ...(cooldownMs ? { cooldownMs } : {}),
    },
    schedule: scheduleInput(draft),
  };
}

export function storyAutomationCreateInput(draft: StoryAutomationDraft, storyId: string): StoryAutomationInput {
  return { ...mutableInput(draft), actionId: draft.actionId, storyId } as StoryAutomationInput;
}

export function storyAutomationUpdateInput(draft: StoryAutomationDraft): StoryAutomationUpdateInput {
  return mutableInput(draft);
}

export function storyAutomationWithActionInput(draft: StoryAutomationDraft, action: StoryAction): StoryAutomationWithActionInput {
  return { action, automation: mutableInput(draft) };
}
