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
  subscribeRemoteDesktopVideoDimensions,
  subscribeRemoteDesktopTextInput,
  type RemoteDesktopTextInputEvent,
} from './TaskHandoffRemoteDesktopModule';
