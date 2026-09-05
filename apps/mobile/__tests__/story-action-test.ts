import { StoryActionSchema } from '@task-handoff/protocol/stories';

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
});
