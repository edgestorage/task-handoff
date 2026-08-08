import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import { ToolActivityText } from '../src/ai-sessions/ToolActivityText';

test('tool activity derives its duration from the measured logical text width', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const timing = jest.spyOn(Animated, 'timing').mockImplementation(() => ({
    reset: () => undefined,
    start: () => undefined,
    stop: () => undefined,
  }));
  const screen = await render(<ToolActivityText running>Thinking… · 2 tools completed</ToolActivityText>);

  await fireEvent(screen.getByTestId('tool-activity-text'), 'layout', { nativeEvent: { layout: { height: 18, width: 320, x: 0, y: 0 } } });
  await fireEvent(screen.getByTestId('tool-activity-label'), 'layout', { nativeEvent: { layout: { height: 18, width: 256, x: 0, y: 0 } } });

  await waitFor(() => expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    duration: (400 / 150) * 1_000,
    toValue: 328,
    useNativeDriver: true,
  })));
  timing.mockRestore();
});
