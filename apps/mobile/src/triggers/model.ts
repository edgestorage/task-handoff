import type { ControlPlaneTrigger, ControlPlaneTriggerTemplateInput, TriggerSource } from '@task-handoff/protocol/triggers';

export type TriggerSourceType = TriggerSource['type'];
export type TriggerScheduleKind = 'interval' | 'daily' | 'weekly';
export type TriggerFormDraft = {
  name: string;
  description: string;
  sourceType: TriggerSourceType;
  scheduleKind: TriggerScheduleKind;
  intervalValue: string;
  intervalUnit: 'minute' | 'hour' | 'day' | 'week';
  timeOfDay: string;
  timezone: string;
  weekdays: number[];
  roots: string;
  globs: string;
  ignore: string;
  debounceMs: string;
  agent: string;
  statuses: ('running' | 'waiting' | 'idle' | 'failed')[];
  phases: ('thinking' | 'tool' | 'editing' | 'approval' | 'responding' | 'unknown')[];
  cooldownMs: string;
  whenBusy: 'skip' | 'queue';
  maxConcurrentRuns: string;
  promptTemplate: string;
};

const intervalUnits = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 } as const;

export function emptyTriggerDraft(): TriggerFormDraft {
  return {
    name: '', description: '', sourceType: 'schedule', scheduleKind: 'interval', intervalValue: '1', intervalUnit: 'hour',
    timeOfDay: '09:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', weekdays: [1, 2, 3, 4, 5],
    roots: '/workspace', globs: '**/*', ignore: 'node_modules/**, .git/**', debounceMs: '1500', agent: '', statuses: ['idle', 'failed'], phases: [],
    cooldownMs: '0', whenBusy: 'skip', maxConcurrentRuns: '1', promptTemplate: 'Please review the current context and continue with the next useful step.',
  };
}

export function triggerDraft(config: ControlPlaneTrigger['config']): TriggerFormDraft {
  const draft = emptyTriggerDraft();
  draft.name = config.name;
  draft.description = config.description || '';
  draft.sourceType = config.source.type;
  draft.cooldownMs = String(config.policy.cooldownMs || 0);
  draft.whenBusy = config.policy.whenBusy;
  draft.maxConcurrentRuns = String(config.policy.maxConcurrentRuns);
  draft.promptTemplate = config.action.promptTemplate;
  if (config.source.type === 'file-change') {
    draft.roots = config.source.roots.join(', ');
    draft.globs = config.source.globs.join(', ');
    draft.ignore = (config.source.ignore || []).join(', ');
    draft.debounceMs = String(config.source.debounceMs);
  } else if (config.source.type === 'ai-session') {
    draft.agent = config.source.agent || '';
    draft.statuses = [...(config.source.statuses || [])];
    draft.phases = [...(config.source.phases || [])];
  } else if (config.source.scheduleKind === 'interval') {
    const intervalMs = config.source.intervalMs;
    const unit = (['week', 'day', 'hour', 'minute'] as const).find((candidate) => intervalMs % intervalUnits[candidate] === 0) || 'minute';
    draft.scheduleKind = 'interval';
    draft.intervalUnit = unit;
    draft.intervalValue = String(intervalMs / intervalUnits[unit]);
  } else {
    draft.scheduleKind = config.source.scheduleKind;
    draft.timeOfDay = config.source.timeOfDay;
    draft.timezone = config.source.timezone;
    if (config.source.scheduleKind === 'weekly') draft.weekdays = [...config.source.weekdays];
  }
  return draft;
}

export function triggerInput(draft: TriggerFormDraft): ControlPlaneTriggerTemplateInput {
  const source = triggerSource(draft);
  return {
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    source,
    action: { promptTemplate: draft.promptTemplate.trim() },
    policy: {
      cooldownMs: integer(draft.cooldownMs, 0, 0, 86_400_000),
      maxConcurrentRuns: integer(draft.maxConcurrentRuns, 1, 1, 20),
      whenBusy: draft.whenBusy,
    },
  };
}

function triggerSource(draft: TriggerFormDraft): TriggerSource {
  if (draft.sourceType === 'file-change') return {
    type: 'file-change', roots: csv(draft.roots), globs: csv(draft.globs), ignore: csv(draft.ignore), debounceMs: integer(draft.debounceMs, 1500, 100, 60_000),
  };
  if (draft.sourceType === 'ai-session') return {
    type: 'ai-session',
    ...(draft.agent.trim() ? { agent: draft.agent.trim() } : {}),
    ...(draft.statuses.length ? { statuses: draft.statuses } : {}),
    ...(draft.phases.length ? { phases: draft.phases } : {}),
  };
  if (draft.scheduleKind === 'daily') return { type: 'schedule', scheduleKind: 'daily', timeOfDay: draft.timeOfDay, timezone: draft.timezone.trim() || 'UTC' };
  if (draft.scheduleKind === 'weekly') return { type: 'schedule', scheduleKind: 'weekly', weekdays: draft.weekdays.length ? [...draft.weekdays].sort() : [1], timeOfDay: draft.timeOfDay, timezone: draft.timezone.trim() || 'UTC' };
  return { type: 'schedule', scheduleKind: 'interval', intervalMs: integer(draft.intervalValue, 1, 1) * intervalUnits[draft.intervalUnit] };
}

function csv(value: string) { return value.split(',').map((entry) => entry.trim()).filter(Boolean); }
function integer(value: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? Math.round(parsed) : fallback));
}

export function triggerSourceSummary(source: TriggerSource) {
  if (source.type === 'file-change') return `${source.roots.join(', ')} · ${source.globs.join(', ')}`;
  if (source.type === 'ai-session') return [source.agent, source.statuses?.join(', '), source.phases?.join(', ')].filter(Boolean).join(' · ') || 'Any AI Session update';
  if (source.scheduleKind === 'interval') return `Every ${source.intervalMs / 60_000} min`;
  if (source.scheduleKind === 'daily') return `Daily ${source.timeOfDay} · ${source.timezone}`;
  return `Weekly ${source.weekdays.join(', ')} · ${source.timeOfDay} · ${source.timezone}`;
}
