import type { Translate } from '../i18n';
import type { RemoteDesktopError } from './types';

export function remoteDesktopErrorMessage(error: RemoteDesktopError | undefined, t: Translate) {
  if (!error) return '';
  const code = error.code;
  if (code === 'REMOTE_DESKTOP_NOT_FOUND' || code === 'REMOTE_DESKTOP_STALE_BOOT' || code === 'REMOTE_DESKTOP_DEADLINE_EXCEEDED' || code === 'REMOTE_DESKTOP_SESSION_CLOSED') return t('remoteDesktop.sessionNotFound');
  if (code === 'REMOTE_DESKTOP_DISABLED' || code === 'REMOTE_DESKTOP_UNSUPPORTED' || code === 'REMOTE_DESKTOP_PLATFORM_UNSUPPORTED' || code === 'REMOTE_DESKTOP_BACKEND_NOT_IMPLEMENTED' || code === 'REMOTE_DESKTOP_WSL_UNSUPPORTED' || code === 'REMOTE_DESKTOP_WAYLAND_UNSUPPORTED' || code === 'REMOTE_DESKTOP_VIRTUAL_PLATFORM_UNSUPPORTED') return t('remoteDesktop.unsupportedDescription');
  if (code.startsWith('REMOTE_DESKTOP_WINDOW_')) return t('remoteDesktop.windowCaptureUnavailable');
  if (code === 'REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED' || code === 'REMOTE_DESKTOP_INPUT_PERMISSION_REQUIRED' || code === 'REMOTE_DESKTOP_CAPTURE_UNAVAILABLE' || code === 'REMOTE_DESKTOP_DESKTOP_UNAVAILABLE' || code === 'REMOTE_DESKTOP_NO_INTERACTIVE_SESSION') return t('remoteDesktop.needsPermission');
  if (code === 'REMOTE_DESKTOP_BUSY' || code === 'REMOTE_DESKTOP_RATE_LIMIT' || code === 'REMOTE_DESKTOP_RATE_LIMITED' || code === 'REMOTE_DESKTOP_REQUEST_CONFLICT') return t('remoteDesktop.busy');
  if (code === 'REMOTE_DESKTOP_TURN_REQUIRED' || code === 'REMOTE_DESKTOP_TURN_UNAVAILABLE') return t('remoteDesktop.turnRequired');
  if (code === 'REMOTE_DESKTOP_TRANSPORT_DISABLED' || code === 'REMOTE_DESKTOP_TRANSPORT_UNAVAILABLE' || code === 'REMOTE_DESKTOP_ICE_TIMEOUT' || code === 'REMOTE_DESKTOP_FALLBACK_FAILED' || code === 'REMOTE_DESKTOP_ICE_FAILED' || code === 'REMOTE_DESKTOP_SIGNAL_CLOSED' || code === 'REMOTE_DESKTOP_SIGNAL_SOCKET_ERROR') return t('remoteDesktop.transportConnectionFailed');
  if (code === 'REMOTE_DESKTOP_DECODER_UNAVAILABLE') return t('remoteDesktop.nativeUnavailable');
  return error.message || t('remoteDesktop.errorGeneric');
}
