import { resolveStoryOwnerNodeId } from '../src/stories/StoryEditor';

describe('StoryEditor', () => {
  test('selects the first available node after the directory loads', () => {
    expect(resolveStoryOwnerNodeId('', [])).toBe('');
    expect(resolveStoryOwnerNodeId('', [{ id: 'node-1' }])).toBe('node-1');
    expect(resolveStoryOwnerNodeId('node-2', [{ id: 'node-1' }])).toBe('node-2');
  });
});
