import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

export type MobileKeyboardEasing = 'easeIn' | 'easeInEaseOut' | 'easeOut' | 'linear' | 'keyboard';
export type MobileKeyboardState = { visible: boolean; height: number; duration: number; easing: MobileKeyboardEasing };

const DEFAULT_KEYBOARD_DURATION_MS = 250;

function keyboardState(event: KeyboardEvent, visible: boolean): MobileKeyboardState {
  return {
    visible,
    height: visible ? event.endCoordinates.height : 0,
    duration: event.duration > 0 ? event.duration : DEFAULT_KEYBOARD_DURATION_MS,
    easing: event.easing ?? 'keyboard',
  };
}

export function subscribeToKeyboardState(listener: (state: MobileKeyboardState) => void) {
  const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
  const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
  const show = Keyboard.addListener(showEvent, (event) => {
    listener(keyboardState(event, true));
  });
  const hide = Keyboard.addListener(hideEvent, (event) => {
    listener(keyboardState(event, false));
  });
  const change = Platform.OS === 'ios' ? Keyboard.addListener('keyboardWillChangeFrame', (event) => {
    const height = Math.max(0, event.endCoordinates.height);
    listener(keyboardState(event, height > 0));
  }) : undefined;
  return () => {
    show.remove();
    hide.remove();
    change?.remove();
  };
}
