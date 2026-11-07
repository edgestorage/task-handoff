import { act, fireEvent, render } from '@testing-library/react-native';
import { useEffect, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useResourceBack } from '../src/components/resource-back';
import { SessionResourceLayout } from '../src/ai-sessions/SessionResourceLayout';

jest.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => { const pan = { runOnJS: () => pan, onChange: () => pan }; return pan; } },
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
}));


const insets = { left: 0, right: 0, top: 0, bottom: 0 };

test('open, collapse and overlay/inline changes preserve the conversation and resource trees', async () => {
  const mounted = { conversation: 0, resource: 0 };
  function Stateful({ kind }: { kind: keyof typeof mounted }) {
    const [count, setCount] = useState(0);
    useEffect(() => { mounted[kind] += 1; }, [kind]);
    return <Pressable testID={kind} onPress={() => setCount((value) => value + 1)}><Text>{`${kind}:${count}`}</Text></Pressable>;
  }
  const props = { fraction: 0.4, onClose: jest.fn(), onFractionChange: jest.fn() };
  const content = (expanded: boolean) => <SafeAreaInsetsContext.Provider value={insets}><SessionResourceLayout {...props} expanded={expanded} panel={<Stateful kind="resource" />}><Stateful kind="conversation" /></SessionResourceLayout></SafeAreaInsetsContext.Provider>;
  const screen = await render(content(false));
  await fireEvent.press(screen.getByTestId('conversation'));
  await screen.rerender(content(true));
  await fireEvent(screen.getByTestId('session-resource-layout'), 'layout', { nativeEvent: { layout: { width: 390, height: 800 } } });
  expect(screen.getByTestId('session-resource-panel').props.accessibilityViewIsModal).toBe(true);
  await fireEvent.press(screen.getByTestId('resource'));
  await fireEvent(screen.getByTestId('session-resource-layout'), 'layout', { nativeEvent: { layout: { width: 1100, height: 800 } } });
  expect(screen.getByTestId('session-resource-panel').props.accessibilityViewIsModal).toBe(false);
  await screen.rerender(content(false));
  await screen.rerender(content(true));
  expect(screen.getByText('conversation:1')).toBeTruthy();
  expect(screen.getByText('resource:1')).toBeTruthy();
  expect(mounted).toEqual({ conversation: 1, resource: 1 });
  await act(async () => { await screen.unmount(); });
});


test('Android Back leaves the nested resource before closing the overlay', async () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  const handlers: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  const listener = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.push(handler);
    return { remove: () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); } };
  });
  const close = jest.fn();
  const nestedBack = jest.fn(() => true);
  function Nested() { useResourceBack(true, nestedBack); return <Text>nested resource</Text>; }
  try {
    const screen = await render(<SafeAreaInsetsContext.Provider value={insets}><SessionResourceLayout expanded fraction={0.4} onClose={close} onFractionChange={jest.fn()} panel={<Nested />}><Text>conversation</Text></SessionResourceLayout></SafeAreaInsetsContext.Provider>);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]({} as Parameters<Parameters<typeof BackHandler.addEventListener>[1]>[0])).toBe(true);
    expect(nestedBack).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    nestedBack.mockReturnValue(false);
    expect(handlers[0]({} as Parameters<Parameters<typeof BackHandler.addEventListener>[1]>[0])).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    await screen.unmount();
  } finally { listener.mockRestore(); platform.restore(); }
});

test('compact resources replace the conversation with a full-width page and keep activity visible', async () => {
  const close = jest.fn();
  const screen = await render(<SafeAreaInsetsContext.Provider value={insets}>
    <SessionResourceLayout
      activity={{ lastMessage: 'The repository is now accessible.', text: 'Running tests', running: true }}
      expanded
      fraction={0.4}
      onClose={close}
      onFractionChange={jest.fn()}
      panel={<Text>resource page</Text>}
      topInset={92}
    ><Text>conversation</Text></SessionResourceLayout>
  </SafeAreaInsetsContext.Provider>);

  await fireEvent(screen.getByTestId('session-resource-layout'), 'layout', { nativeEvent: { layout: { width: 390, height: 800 } } });
  const panel = StyleSheet.flatten(screen.getByTestId('session-resource-panel').props.style);
  expect(panel.width).toBe(390);
  expect(panel.top).toBe(0);
  expect(panel.paddingTop).toBe(92);
  expect(panel.borderLeftWidth).toBe(0);
  expect(screen.getByTestId('session-resource-top-backdrop').props.style).toEqual(expect.arrayContaining([expect.objectContaining({ height: 92 })]));
  expect(screen.getByText('resource page')).toBeTruthy();
  expect(screen.getByTestId('session-resource-activity')).toBeTruthy();
  expect(screen.getByText('Running tests')).toBeTruthy();
  expect(screen.getByTestId('session-resource-last-message').props.numberOfLines).toBe(2);
  expect(screen.getByTestId('session-resource-last-message').props.children).toBe('The repository is now accessible.');
  await fireEvent.press(screen.getByTestId('session-resource-activity'));
  expect(close).toHaveBeenCalledTimes(1);

  await fireEvent(screen.getByTestId('session-resource-layout'), 'layout', { nativeEvent: { layout: { width: 1100, height: 800 } } });
  const inlinePanel = StyleSheet.flatten(screen.getByTestId('session-resource-panel').props.style);
  expect(inlinePanel.width).toBeLessThan(1100);
  expect(screen.queryByTestId('session-resource-activity')).toBeNull();
  await screen.unmount();
});
