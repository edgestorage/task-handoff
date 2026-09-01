import { renderStoryActionPrompt } from '../src/stories/StoryActionForm';

describe('Story action prompt', () => {
  test('substitutes explicit values and parameter defaults', () => {
    expect(renderStoryActionPrompt(
      'Deploy {{ environment }} with {{mode}} and {{ missing }}',
      [{ name: 'environment', defaultValue: 'test' }, { name: 'mode', defaultValue: 'safe' }],
      { environment: 'staging' },
    )).toBe('Deploy staging with safe and ');
  });
});
