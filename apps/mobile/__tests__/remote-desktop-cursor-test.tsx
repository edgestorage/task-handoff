import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { RemoteDesktopCursor, REMOTE_DESKTOP_CURSOR_SIZE } from '../src/remote-desktop/RemoteDesktopCursor';

test('renders a compact macOS-shaped pointer anchored at its tip', async () => {
  const screen = await render(<RemoteDesktopCursor accentColor="#4c9aff" dragging={false} point={{ x: 0.25, y: 0.75 }} />);
  const cursor = screen.getByTestId('remote-desktop-cursor');
  const style = StyleSheet.flatten(cursor.props.style);
  const icon = screen.getByTestId('remote-desktop-cursor-icon');

  expect(REMOTE_DESKTOP_CURSOR_SIZE).toEqual({ height: 19, width: 12 });
  expect(style).toMatchObject({
    height: 19,
    left: '25%',
    marginLeft: -1,
    marginTop: -1,
    top: '75%',
    width: 12,
  });
  expect(icon.props).toMatchObject({ height: 19, width: 12 });
  expect(cursor.props.pointerEvents).toBe('none');
  screen.unmount();
});
