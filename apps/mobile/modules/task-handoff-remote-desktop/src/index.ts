export { default as RemoteDesktopSurface } from './RemoteDesktopSurface';
export * from './RemoteDesktopDecoder.types';
export {
  closeRemoteDesktopDecoder,
  configureRemoteDesktopDecoder,
  decodeRemoteDesktopFrame,
  nativeRemoteDesktopDecoderAvailable,
  nativeRemoteDesktopTextInputAvailable,
  resetRemoteDesktopDecoder,
  startRemoteDesktopTextInputObservation,
  stopRemoteDesktopTextInputObservation,
  subscribeRemoteDesktopDecoderErrors,
  subscribeRemoteDesktopTextInput,
  type RemoteDesktopTextInputEvent,
} from './TaskHandoffRemoteDesktopModule';
