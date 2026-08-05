import { Keyboard, Platform } from 'react-native';

export type MobileKeyboardState = { visible: boolean; height: number };

export function subscribeToKeyboardState(listener: (state: MobileKeyboardState) => void) {
  const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
  const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
  const show = Keyboard.addListener(showEvent, (event) => {
    listener({ visible: true, height: event.endCoordinates.height });
  });
  const hide = Keyboard.addListener(hideEvent, () => {
    listener({ visible: false, height: 0 });
  });
  return () => {
    show.remove();
    hide.remove();
  };
}
