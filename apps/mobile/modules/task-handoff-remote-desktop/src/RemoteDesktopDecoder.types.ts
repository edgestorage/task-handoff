export type RemoteDesktopCodecConfig = {
  /** RFC 6381 codec string, for example avc1.42E028 or hvc1.1.6.L120.90. */
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
};

export type RemoteDesktopDecoderError = {
  code: string;
  message?: string;
};

export type RemoteDesktopSurfaceProps = {
  style?: import('react-native').StyleProp<import('react-native').ViewStyle>;
};
