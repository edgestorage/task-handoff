import { StoryActionSchema } from '@task-handoff/protocol/stories';
import { renderStoryActionPrompt, resolveStoryActionPrompt } from '../src/stories/StoryActionForm';

describe('Story action prompt', () => {
  test('substitutes explicit values and parameter defaults', () => {
    expect(renderStoryActionPrompt(
      'Deploy {{ environment }} with {{mode}} and {{ missing }}',
      [{ name: 'environment', defaultValue: 'test' }, { name: 'mode', defaultValue: 'safe' }],
      { environment: 'staging' },
    )).toBe('Deploy staging with safe and ');
  });

  test('resolves a preset action directly from defaults and reports unresolved required parameters', () => {
    const action = StoryActionSchema.parse({
      id: 'deploy',
      title: 'Deploy',
      promptTemplate: 'Deploy {{environment}} in {{mode}} mode',
      parameters: [
        { name: 'environment', label: 'Environment', required: true, defaultValue: 'staging' },
        { name: 'mode', label: 'Mode', required: false },
      ],
    });
    expect(resolveStoryActionPrompt(action)).toEqual({ ok: true, message: 'Deploy staging in  mode' });

    expect(resolveStoryActionPrompt({
      ...action,
      parameters: [{ name: 'environment', label: 'Environment', required: true }],
    })).toEqual({ ok: false, missingParameter: { name: 'environment', label: 'Environment', required: true } });
  });
});
