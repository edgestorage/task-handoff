import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import type { RemoteDesktopPoint } from './geometry';

export const REMOTE_DESKTOP_CURSOR_SIZE = { height: 19, width: 12 } as const;

const CURSOR_INSET = 1;
const CURSOR_PATH = 'M1 1 L1 15.1 L4.05 12.2 L6.35 17.25 C6.5 17.6 6.85 17.75 7.2 17.6 L8.6 17 C8.95 16.85 9.1 16.5 8.95 16.15 L6.65 11.2 L10.2 11.2 C10.75 11.2 10.95 10.6 10.55 10.3 Z';

type Props = {
  accentColor: string;
  dragging: boolean;
  point: RemoteDesktopPoint;
};

export function RemoteDesktopCursor({ accentColor, dragging, point }: Props) {
  return <View
    pointerEvents="none"
    style={[styles.cursor, { left: `${point.x * 100}%`, top: `${point.y * 100}%` }]}
    testID="remote-desktop-cursor"
  >
    <Svg
      height={REMOTE_DESKTOP_CURSOR_SIZE.height}
      testID="remote-desktop-cursor-icon"
      viewBox={`0 0 ${REMOTE_DESKTOP_CURSOR_SIZE.width} ${REMOTE_DESKTOP_CURSOR_SIZE.height}`}
      width={REMOTE_DESKTOP_CURSOR_SIZE.width}
    >
      <Path d={CURSOR_PATH} fill="rgba(0,0,0,0.24)" transform="translate(0.55 0.8)" />
      <Path d={CURSOR_PATH} fill={dragging ? accentColor : '#111217'} stroke={dragging ? '#eef7ff' : '#ffffff'} strokeLinejoin="round" strokeWidth={1.05} />
    </Svg>
  </View>;
}

const styles = StyleSheet.create({
  cursor: { height: REMOTE_DESKTOP_CURSOR_SIZE.height, marginLeft: -CURSOR_INSET, marginTop: -CURSOR_INSET, position: 'absolute', width: REMOTE_DESKTOP_CURSOR_SIZE.width },
});
