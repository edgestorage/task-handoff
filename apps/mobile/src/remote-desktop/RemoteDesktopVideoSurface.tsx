import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { RTCView } from 'react-native-webrtc';

import RemoteDesktopSurface from '../../modules/task-handoff-remote-desktop/src/RemoteDesktopSurface';
import type { RemoteDesktopSize } from './geometry';
import type { RemoteDesktopSnapshot } from './types';

export function RemoteDesktopVideoSurface({
  onStreamSizeChange,
  snapshot,
  style = StyleSheet.absoluteFill,
}: {
  onStreamSizeChange?(size: RemoteDesktopSize): void;
  snapshot: RemoteDesktopSnapshot;
  style?: StyleProp<ViewStyle>;
}) {
  if (snapshot.path === 'websocket') return <RemoteDesktopSurface style={style} />;
  if (!snapshot.streamURL) return null;
  return <RTCView
    mirror={false}
    objectFit="contain"
    onDimensionsChange={(event) => {
      const size = { width: event.nativeEvent.width, height: event.nativeEvent.height };
      if (size.width > 0 && size.height > 0) onStreamSizeChange?.(size);
    }}
    streamURL={snapshot.streamURL}
    style={style}
  />;
}
