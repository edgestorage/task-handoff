import {
  SESSION_COMPOSER_COLLAPSED_INPUT_PADDING_BOTTOM,
  SESSION_COMPOSER_COLLAPSED_INPUT_PADDING_TOP,
  SESSION_COMPOSER_EXPANDED_INPUT_PADDING_BOTTOM,
  SESSION_COMPOSER_EXPANDED_INPUT_PADDING_TOP,
  SESSION_COMPOSER_FOCUSED_MAX_HEIGHT,
  SESSION_COMPOSER_FOCUSED_MAX_LINES,
  SESSION_COMPOSER_FOCUSED_MIN_HEIGHT,
  SESSION_COMPOSER_FOCUSED_MIN_LINES,
  SESSION_COMPOSER_INPUT_LINE_HEIGHT,
  sessionComposerExpandedHeightForContentSize,
} from '../src/ai-sessions/composer-metrics';

const collapsedVerticalPadding = SESSION_COMPOSER_COLLAPSED_INPUT_PADDING_TOP + SESSION_COMPOSER_COLLAPSED_INPUT_PADDING_BOTTOM;
const focusedVerticalPadding = SESSION_COMPOSER_EXPANDED_INPUT_PADDING_TOP + SESSION_COMPOSER_EXPANDED_INPUT_PADDING_BOTTOM;

function contentSizeForLines(lineCount: number, verticalPadding = focusedVerticalPadding) {
  return verticalPadding + lineCount * SESSION_COMPOSER_INPUT_LINE_HEIGHT;
}

test('focused composer starts at two lines and grows through four lines', () => {
  expect(SESSION_COMPOSER_FOCUSED_MIN_LINES).toBe(2);
  expect(SESSION_COMPOSER_FOCUSED_MAX_LINES).toBe(4);
  expect(SESSION_COMPOSER_FOCUSED_MIN_HEIGHT).toBe(118);
  expect(SESSION_COMPOSER_FOCUSED_MAX_HEIGHT).toBe(164);
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(1))).toBe(SESSION_COMPOSER_FOCUSED_MIN_HEIGHT);
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(2))).toBe(SESSION_COMPOSER_FOCUSED_MIN_HEIGHT);
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(3))).toBe(
    SESSION_COMPOSER_FOCUSED_MIN_HEIGHT + SESSION_COMPOSER_INPUT_LINE_HEIGHT,
  );
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(4))).toBe(SESSION_COMPOSER_FOCUSED_MAX_HEIGHT);
});

test('focused composer caps scrolling content at four lines', () => {
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(8))).toBe(SESSION_COMPOSER_FOCUSED_MAX_HEIGHT);
});

test('focus-transition padding does not round the measured line count up', () => {
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(2, collapsedVerticalPadding))).toBe(
    SESSION_COMPOSER_FOCUSED_MIN_HEIGHT,
  );
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(3, collapsedVerticalPadding))).toBe(
    SESSION_COMPOSER_FOCUSED_MIN_HEIGHT + SESSION_COMPOSER_INPUT_LINE_HEIGHT,
  );
  expect(sessionComposerExpandedHeightForContentSize(contentSizeForLines(4, collapsedVerticalPadding))).toBe(
    SESSION_COMPOSER_FOCUSED_MAX_HEIGHT,
  );
});
