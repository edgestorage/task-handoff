export { default as RemoteDesktopSurface } from './RemoteDesktopSurface';
export * from './RemoteDesktopDecoder.types';
export {
  closeRemoteDesktopDecoder,
  configureRemoteDesktopDecoder,
  currentRemoteDesktopLandscapeSide,
  decodeRemoteDesktopFrame,
  nativeRemoteDesktopDecoderAvailable,
  nativeRemoteDesktopTextInputAvailable,
  resetRemoteDesktopDecoder,
  startRemoteDesktopTextInputObservation,
  stopRemoteDesktopTextInputObservation,
  subscribeRemoteDesktopDecoderErrors,
  subscribeRemoteDesktopOrientation,
  subscribeRemoteDesktopVideoDimensions,
  subscribeRemoteDesktopTextInput,
  type RemoteDesktopLandscapeSide,
  type RemoteDesktopOrientationEvent,
  type RemoteDesktopTextInputEvent,
} from './TaskHandoffRemoteDesktopModule';
