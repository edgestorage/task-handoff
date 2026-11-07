import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { ControlPlaneAiSessionSummarySchema } from '@task-handoff/control-plane-client';

import { SessionDetail } from '../src/ai-sessions/SessionDetail';

const text = 'First line\nSecond line\nThird line\nFourth line\nFifth line';
const session = ControlPlaneAiSessionSummarySchema.parse({
  id: 'session', agent: 'codex', status: 'idle',
  startedAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:01Z',
  turns: [{ id: 'turn', userPrompt: text, lastMessage: 'Assistant reply', status: 'completed' }],
});

test('long user messages start collapsed, expand on demand, and can be collapsed again', async () => {
  const screen = await render(<SessionDetail messages={[]} mode="turn" session={session} />);
  const viewport = () => getAnimatedStyle(screen.getByTestId('user-message-viewport'));
  const collapsedHeight = Number(viewport().maxHeight);
  const fullHeight = collapsedHeight + 24;
  const fadeView = () => screen.getByTestId('user-message-fade', { includeHiddenElements: true });
  const fade = () => getAnimatedStyle(fadeView());
  expect(collapsedHeight).toBeGreaterThan(0);
  await fireEvent(screen.getByTestId('user-message-full-content'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 280, height: fullHeight } } });
  expect(screen.getByRole('button', { name: 'Expand' }).props.accessibilityState.expanded).toBe(false);
  expect(fade().opacity).toBe(1);
  expect(fadeView().props.pointerEvents).toBe('none');
  await fireEvent.press(screen.getByRole('button', { name: 'Expand' }));
  await waitFor(() => {
    expect(viewport().maxHeight).toBe(fullHeight);
    expect(fade().opacity).toBe(0);
  });
  expect(screen.getByRole('button', { name: 'Collapse' }).props.accessibilityState.expanded).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Collapse' }));
  await waitFor(() => {
    expect(viewport().maxHeight).toBe(collapsedHeight);
    expect(fade().opacity).toBe(1);
  });

  // A second tap during expansion must settle at the latest requested state.
  await fireEvent.press(screen.getByRole('button', { name: 'Expand' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Collapse' }));
  await waitFor(() => expect(viewport().maxHeight).toBe(collapsedHeight));

  // Folding is purely visual: copying still uses the complete original message.
  const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  await fireEvent.press(screen.getAllByRole('button', { name: 'Copy' })[0]);
  expect(copy).toHaveBeenCalledWith(text);
  copy.mockRestore();
  expect(screen.getByText('Assistant reply')).toBeTruthy();
  expect(screen.getAllByTestId('user-message-viewport')).toHaveLength(1);
});

test('four lines stay fully visible and a width change rechecks whether expansion is needed', async () => {
  const screen = await render(<SessionDetail messages={[]} mode="turn" session={session} />);
  const height = StyleSheet.flatten(screen.getByTestId('user-message-viewport').props.style).maxHeight;
  const measure = async (width: number, contentHeight: number) => fireEvent(screen.getByTestId('user-message-full-content'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: contentHeight } } });
  await measure(400, height);
  expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
  expect(screen.queryByTestId('user-message-fade', { includeHiddenElements: true })).toBeNull();
  await measure(240, height + 24);
  expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Expand' }));
  await measure(200, height + 48);
  await waitFor(() => expect(getAnimatedStyle(screen.getByTestId('user-message-viewport')).maxHeight).toBe(height + 48));
  await measure(600, height - 24);
  expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
  expect(screen.queryByTestId('user-message-fade', { includeHiddenElements: true })).toBeNull();
});
