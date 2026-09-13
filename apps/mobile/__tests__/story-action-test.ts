import { StoryActionSchema } from '@task-handoff/protocol/stories';
import { storyActionCanStart } from '../src/stories/StoryActionForm';

describe('Story action prompt', () => {
  test('keeps double braces as literal prompt text', () => {
    const action = StoryActionSchema.parse({
      id: 'deploy',
      title: 'Deploy',
      promptTemplate: 'Deploy {{environment}} in {{mode}} mode',
    });
    expect(action.promptTemplate).toBe('Deploy {{environment}} in {{mode}} mode');
  });

  test('rejects the removed parameters field', () => {
    expect(() => StoryActionSchema.parse({
      id: 'deploy',
      title: 'Deploy',
      promptTemplate: 'Deploy',
      parameters: [{ name: 'environment', label: 'Environment', required: true }],
    })).toThrow();
  });

  test('cannot start an Action from an archived Story', () => {
    const action = { id: 'deploy' };
    expect(storyActionCanStart({}, action, 'instance-1')).toBe(true);
    expect(storyActionCanStart({ archivedAt: '2026-09-06T00:00:00.000Z' }, action, 'instance-1')).toBe(false);
  });
});
