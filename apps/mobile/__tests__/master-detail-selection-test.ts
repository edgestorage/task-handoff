import {
  aiSessionDetailSelection,
  instanceDetailSelection,
  resetDetailSelections,
  sameSelection,
  storyDetailSelection,
  storySessionDetailSelection,
} from '../src/master-detail/selection';

describe('master-detail selection store', () => {
  beforeEach(resetDetailSelections);

  test('compares every selection field', () => {
    expect(sameSelection({ instanceId: 'i1', sessionId: 's1' }, { instanceId: 'i1', sessionId: 's1' })).toBe(true);
    expect(sameSelection({ instanceId: 'i1', sessionId: 's1' }, { instanceId: 'i1', sessionId: 's2' })).toBe(false);
    expect(sameSelection(undefined, undefined)).toBe(true);
    expect(sameSelection({ instanceId: 'i1' }, undefined)).toBe(false);
  });

  test('notifies only when a selection changes and clears it once', () => {
    const listener = jest.fn();
    const unsubscribe = aiSessionDetailSelection.subscribe(listener);
    const selected = { controlPlaneId: 'cp1', instanceId: 'i1', sessionId: 's1' };
    aiSessionDetailSelection.set(selected);
    aiSessionDetailSelection.set({ ...selected });
    expect(listener).toHaveBeenCalledTimes(1);
    aiSessionDetailSelection.clear();
    aiSessionDetailSelection.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(aiSessionDetailSelection.get()).toBeUndefined();
    unsubscribe();
  });

  test('keeps each workbench selection independent and resets them together', () => {
    aiSessionDetailSelection.set({ controlPlaneId: 'cp1', instanceId: 'i1', sessionId: 's1' });
    storyDetailSelection.set({ controlPlaneId: 'cp1', nodeId: 'n1', storyId: 'story1' });
    storySessionDetailSelection.set({ controlPlaneId: 'cp1', nodeId: 'n1', storyId: 'story1', instanceId: 'i1', sessionId: 's1' });
    instanceDetailSelection.set({ controlPlaneId: 'cp1', instanceId: 'i1' });
    expect(storyDetailSelection.get()).toEqual({ controlPlaneId: 'cp1', nodeId: 'n1', storyId: 'story1' });
    expect(storySessionDetailSelection.get()).toEqual({ controlPlaneId: 'cp1', nodeId: 'n1', storyId: 'story1', instanceId: 'i1', sessionId: 's1' });
    expect(instanceDetailSelection.get()).toEqual({ controlPlaneId: 'cp1', instanceId: 'i1' });
    resetDetailSelections();
    expect(aiSessionDetailSelection.get()).toBeUndefined();
    expect(storyDetailSelection.get()).toBeUndefined();
    expect(storySessionDetailSelection.get()).toBeUndefined();
    expect(instanceDetailSelection.get()).toBeUndefined();
  });
});
