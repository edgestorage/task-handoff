import { act, fireEvent, render } from '@testing-library/react-native';

import { RemoteDesktopKeyboardBar, RemoteDesktopVirtualKeyboard } from '../src/remote-desktop/RemoteDesktopVirtualKeyboard';
import {
  EMPTY_REMOTE_DESKTOP_MODIFIER_STATE,
  REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES,
  lockRemoteDesktopModifier,
  releaseArmedRemoteDesktopModifiers,
  remoteDesktopModifierBitMask,
  tapRemoteDesktopModifier,
} from '../src/remote-desktop/virtual-keyboard';

jest.mock('../src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test('the function page exposes hardware function and navigation keys', () => {
  const fn = REMOTE_DESKTOP_VIRTUAL_KEYBOARD_PAGES.find((page) => page.id === 'fn');
  const codes = fn?.rows.flat().map((key) => key.code) ?? [];
  for (let value = 1; value <= 12; value += 1) expect(codes).toContain(`F${value}`);
  expect(codes).toEqual(expect.arrayContaining(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']));
});

test('one-shot modifiers release after input while locked modifiers stay down', () => {
  let state = tapRemoteDesktopModifier(EMPTY_REMOTE_DESKTOP_MODIFIER_STATE, 'ctrl').state;
  expect(state.ctrl).toBe('armed');
  expect(remoteDesktopModifierBitMask(state)).toBe(1);
  const released = releaseArmedRemoteDesktopModifiers(state);
  expect(released.released).toEqual(['ctrl']);
  expect(released.state.ctrl).toBe('off');

  state = lockRemoteDesktopModifier(EMPTY_REMOTE_DESKTOP_MODIFIER_STATE, 'shift').state;
  expect(state.shift).toBe('locked');
  expect(releaseArmedRemoteDesktopModifiers(state).state.shift).toBe('locked');
});

test('the keyboard bar keeps a separate collapse action on the right', async () => {
  const onCollapse = jest.fn();
  const onMode = jest.fn();
  const screen = await render(<RemoteDesktopKeyboardBar mode="system" onCollapse={onCollapse} onMode={onMode} />);
  await fireEvent.press(screen.getByTestId('remote-desktop-keyboard-collapse'));
  await fireEvent.press(screen.getByText('remoteDesktop.virtualKeyboard'));
  expect(onCollapse).toHaveBeenCalledTimes(1);
  expect(onMode).toHaveBeenCalledWith('virtual');
});

test('virtual keys send down/up and apply a one-shot Ctrl modifier', async () => {
  const sendKey = jest.fn();
  const screen = await render(<RemoteDesktopVirtualKeyboard bottomInset={0} enabled onCollapse={jest.fn()} onMode={jest.fn()} sendKey={sendKey} />);

  const f1 = screen.getByLabelText('F1');
  await act(async () => { fireEvent(f1, 'pressIn'); });
  await act(async () => { fireEvent(f1, 'pressOut'); });
  expect(sendKey).toHaveBeenNthCalledWith(1, 'F1', true, 0);
  expect(sendKey).toHaveBeenNthCalledWith(2, 'F1', false, 0);

  sendKey.mockClear();
  const ctrl = screen.getByLabelText('Ctrl');
  await act(async () => { fireEvent(ctrl, 'pressIn'); });
  await act(async () => { fireEvent(f1, 'pressIn'); });
  await act(async () => { fireEvent(f1, 'pressOut'); });
  expect(sendKey.mock.calls).toEqual([
    ['ControlLeft', true, 1],
    ['F1', true, 1],
    ['F1', false, 1],
    ['ControlLeft', false, 0],
  ]);
});

test('long-pressing a virtual modifier locks it until tapped again', async () => {
  const sendKey = jest.fn();
  const screen = await render(<RemoteDesktopVirtualKeyboard bottomInset={0} enabled onCollapse={jest.fn()} onMode={jest.fn()} sendKey={sendKey} />);
  const ctrl = screen.getByLabelText('Ctrl');
  const f1 = screen.getByLabelText('F1');

  await act(async () => { fireEvent(ctrl, 'pressIn'); });
  await act(async () => { fireEvent(ctrl, 'longPress'); });
  sendKey.mockClear();
  await act(async () => { fireEvent(f1, 'pressIn'); });
  await act(async () => { fireEvent(f1, 'pressOut'); });
  expect(sendKey.mock.calls).toEqual([
    ['F1', true, 1],
    ['F1', false, 1],
  ]);

  await act(async () => { fireEvent(ctrl, 'pressIn'); });
  expect(sendKey).toHaveBeenLastCalledWith('ControlLeft', false, 0);
});

test('unmounting the virtual keyboard releases held remote keys', async () => {
  const sendKey = jest.fn();
  const screen = await render(<RemoteDesktopVirtualKeyboard bottomInset={0} enabled onCollapse={jest.fn()} onMode={jest.fn()} sendKey={sendKey} />);
  const ctrl = screen.getByLabelText('Ctrl');
  await act(async () => { fireEvent(ctrl, 'pressIn'); });
  sendKey.mockClear();
  await act(async () => { screen.unmount(); });
  expect(sendKey).toHaveBeenCalledWith('ControlLeft', false, 0);
});
