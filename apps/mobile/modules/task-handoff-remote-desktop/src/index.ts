export { default as RemoteDesktopSurface } from './RemoteDesktopSurface';
export * from './RemoteDesktopDecoder.types';
export {
  closeRemoteDesktopDecoder,
  configureRemoteDesktopDecoder,
  decodeRemoteDesktopFrame,
  nativeRemoteDesktopDecoderAvailable,
  resetRemoteDesktopDecoder,
  subscribeRemoteDesktopDecoderErrors,
} from './TaskHandoffRemoteDesktopModule';
