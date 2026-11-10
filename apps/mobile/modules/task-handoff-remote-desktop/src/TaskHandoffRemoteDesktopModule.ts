import { requireOptionalNativeModule } from 'expo';

import type {
  RemoteDesktopCodecConfig,
  RemoteDesktopDecoderError,
} from './RemoteDesktopDecoder.types';

type NativeRemoteDesktopModule = {
  isAvailable(): boolean;
  configure(config: RemoteDesktopCodecConfig): Promise<void>;
  decode(data: Uint8Array, keyframe: boolean, timestampUs: number): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
  addListener?(name: 'onRemoteDesktopDecoderError', listener: (event: RemoteDesktopDecoderError) => void): { remove(): void };
};

const native = requireOptionalNativeModule<NativeRemoteDesktopModule>('TaskHandoffRemoteDesktop');

export const nativeRemoteDesktopDecoderAvailable = native?.isAvailable?.() === true;

export function subscribeRemoteDesktopDecoderErrors(listener: (event: RemoteDesktopDecoderError) => void) {
  try { return native?.addListener?.('onRemoteDesktopDecoderError', listener); }
  catch { return undefined; }
}

export async function configureRemoteDesktopDecoder(config: RemoteDesktopCodecConfig) {
  if (!native) throw Object.assign(new Error('The native remote desktop decoder is unavailable.'), { code: 'REMOTE_DESKTOP_DECODER_UNAVAILABLE' });
  await native.configure(config);
}

export async function decodeRemoteDesktopFrame(data: Uint8Array, keyframe: boolean, timestampUs: number) {
  if (!native) return;
  await native.decode(data, keyframe, timestampUs);
}

export async function resetRemoteDesktopDecoder() {
  await native?.reset();
}

export async function closeRemoteDesktopDecoder() {
  await native?.close();
}
