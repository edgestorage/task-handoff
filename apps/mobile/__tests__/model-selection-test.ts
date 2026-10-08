import type { AiSessionModelGroup } from '@task-handoff/control-plane-client';
import {
  modelSelectionFromOption,
  modelSelectionLabel,
  resolveModelSelection,
  sameModelSelection,
} from '../src/ai-sessions/model-selection';

const modelGroups: AiSessionModelGroup[] = [{
  modelEntityId: 'provider-one',
  providerName: 'Provider One',
  models: [
    { modelEntityId: 'provider-one', modelName: 'fast', modelUpstreamName: 'provider-model-a', providerName: 'Provider One' },
    { modelEntityId: 'provider-one', modelName: 'smart', modelUpstreamName: 'provider-model-b', providerName: 'Provider One' },
  ],
}];

test('selections match by upstream identity after a display label rename', () => {
  expect(sameModelSelection(modelGroups[0].models[1], { modelEntityId: 'provider-one', modelName: 'old-smart', modelUpstreamName: 'provider-model-b' })).toBe(true);
  expect(sameModelSelection(modelGroups[0].models[0], { modelEntityId: 'provider-one', modelName: 'old-smart', modelUpstreamName: 'provider-model-b' })).toBe(false);
});

test('legacy selections without an upstream name fall back to the label', () => {
  expect(sameModelSelection(modelGroups[0].models[0], { modelEntityId: 'provider-one', modelName: 'fast' })).toBe(true);
  expect(sameModelSelection(modelGroups[0].models[1], { modelEntityId: 'provider-one', modelName: 'fast' })).toBe(false);
});

test('a stored selection is relabelled to the current catalog label', () => {
  const stored = { modelEntityId: 'provider-one', modelName: 'old-smart', modelUpstreamName: 'provider-model-b' };
  expect(resolveModelSelection(modelGroups, stored)).toEqual({ modelEntityId: 'provider-one', modelName: 'smart', modelUpstreamName: 'provider-model-b' });
  expect(modelSelectionLabel(modelGroups, stored)).toBe('smart');
});

test('a selection missing from the catalog resolves to undefined but keeps its stored label', () => {
  const stored = { modelEntityId: 'provider-one', modelName: 'gone', modelUpstreamName: 'provider-model-gone' };
  expect(resolveModelSelection(modelGroups, stored)).toBeUndefined();
  expect(modelSelectionLabel(modelGroups, stored)).toBe('gone');
});

test('building a selection from an option carries the upstream identity', () => {
  expect(modelSelectionFromOption(modelGroups[0].models[1])).toEqual({
    modelEntityId: 'provider-one',
    modelName: 'smart',
    modelUpstreamName: 'provider-model-b',
  });
});
