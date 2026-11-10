import { requireNativeView } from 'expo';
import type { ComponentType } from 'react';

import type { RemoteDesktopSurfaceProps } from './RemoteDesktopDecoder.types';

let NativeView: ComponentType<RemoteDesktopSurfaceProps> | undefined;
try { NativeView = requireNativeView('TaskHandoffRemoteDesktop'); } catch { NativeView = undefined; }

export default function RemoteDesktopSurface(props: RemoteDesktopSurfaceProps) {
  return NativeView ? <NativeView {...props} /> : null;
}
