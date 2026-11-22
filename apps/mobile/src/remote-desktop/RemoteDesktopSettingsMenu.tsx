import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '../components/Icon';
import { MenuView, type MenuAction } from '../components/MenuView';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import {
  canDisableTransport,
  REMOTE_DESKTOP_CAPTURE_PRECISIONS,
  REMOTE_DESKTOP_RESOLUTIONS,
  type RemoteDesktopCapturePrecision,
  type RemoteDesktopFrameRate,
  type RemoteDesktopResolution,
  type RemoteDesktopTransportKey,
} from './preferences';
import { transportLabel, transportStateLabel } from './transport-presentation';
import type { RemoteDesktopSnapshot } from './types';

type Props = {
  children?: ReactNode;
  capturePrecisionSupported?: boolean;
  clipboardSupported?: boolean;
  onDisconnect(): void;
  onSetClipboardEnabled(enabled: boolean): void;
  onSetCapturePrecision(value: RemoteDesktopCapturePrecision): void;
  onSetInputEnabled(enabled: boolean): void;
  onSetFrameRate(value: RemoteDesktopFrameRate): void;
  onSetResolution(value: RemoteDesktopResolution): void;
  onToggleTransport(key: RemoteDesktopTransportKey): void;
  snapshot: RemoteDesktopSnapshot;
};

const frameRates: readonly RemoteDesktopFrameRate[] = ['auto', '60', '30', '24', '15'];
const transports: readonly RemoteDesktopTransportKey[] = ['p2p', 'turn', 'websocket'];

export function RemoteDesktopSettingsMenu(props: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { snapshot } = props;
  const capturePrecisionSupported = props.capturePrecisionSupported === true;
  const transportActions: MenuAction[] = transports.filter(key => key !== 'turn' || snapshot.connectionOptions?.customTurn.configured).map((key) => {
    const enabled = snapshot.transportAvailability[key];
    return {
      id: `transport:${key}`,
      title: `${key === 'turn' ? t('remoteDesktop.customTurn') : transportLabel(key, t)} · ${transportStateLabel(key, snapshot, t)}`,
      image: transportSFSymbol(key),
      state: enabled ? 'on' : 'off',
      attributes: { disabled: enabled && !canDisableTransport(snapshot.transportAvailability, key) },
    };
  });
  if (snapshot.connectionOptions?.cloudTurn.signedIn) transportActions.push({
    id: 'cloud-turn', title: `${t('remoteDesktop.cloudTurn')} · ${t('remoteDesktop.cloudTurnUnavailable')}`,
    image: 'cloud.fill', state: 'off', attributes: { disabled: true },
  });
  const actions: MenuAction[] = [
    {
      id: 'input',
      title: snapshot.inputRequested ? t('remoteDesktop.disableInput') : t('remoteDesktop.enableInput'),
      image: snapshot.inputRequested ? 'hand.raised.slash' : 'hand.raised',
      attributes: { disabled: snapshot.inputPending || snapshot.controlRequestPending || snapshot.phase === 'stopped' || snapshot.phase === 'error' },
    },
    ...(props.clipboardSupported ? [{
      id: 'clipboard',
      title: snapshot.clipboardEnabled ? t('remoteDesktop.clipboardDisable') : t('remoteDesktop.clipboardEnable'),
      image: 'doc.on.clipboard' as const,
      state: snapshot.clipboardEnabled ? 'on' as const : 'off' as const,
      attributes: { disabled: snapshot.clipboardPending || snapshot.phase === 'stopped' || snapshot.phase === 'error' },
    }] : []),
    {
      id: 'resolution',
      title: t('remoteDesktop.resolution'),
      image: 'arrow.up.left.and.arrow.down.right',
      subactions: REMOTE_DESKTOP_RESOLUTIONS.map((value) => ({
        id: `resolution:${value}`,
        title: resolutionLabel(value, t),
        state: snapshot.resolution === value ? 'on' : 'off',
      })),
    },
    {
      id: 'frame-rate',
      title: t('remoteDesktop.frameRate'),
      image: 'speedometer',
      subactions: frameRates.map((value) => ({
        id: `frame-rate:${value}`,
        title: value === 'auto' ? t('remoteDesktop.auto') : t('remoteDesktop.framesPerSecond', { value }),
        state: snapshot.frameRate === value ? 'on' : 'off',
      })),
    },
    ...(capturePrecisionSupported ? [{
      id: 'capture-precision',
      title: t('remoteDesktop.capturePrecision'),
      image: 'viewfinder' as const,
      subactions: REMOTE_DESKTOP_CAPTURE_PRECISIONS.map((value) => ({
        id: `capture-precision:${value}`,
        title: value === 'auto' ? t('remoteDesktop.auto') : t('remoteDesktop.performance'),
        state: snapshot.capturePrecision === value ? 'on' as const : 'off' as const,
      })),
    }] : []),
    {
      id: 'connection-methods',
      title: t('remoteDesktop.connectionMethods'),
      image: 'network',
      subactions: transportActions,
    },
    {
      id: 'disconnect',
      title: t('remoteDesktop.disconnect'),
      image: 'xmark.circle',
      attributes: { destructive: true, disabled: snapshot.phase === 'stopped' || snapshot.phase === 'error' },
    },
  ];
  const select = (event: string) => {
    if (event === 'input') props.onSetInputEnabled(!snapshot.inputRequested);
    else if (event === 'clipboard') props.onSetClipboardEnabled(!snapshot.clipboardEnabled);
    else if (event === 'disconnect') props.onDisconnect();
    else if (event.startsWith('resolution:')) props.onSetResolution(event.slice('resolution:'.length) as RemoteDesktopResolution);
    else if (event.startsWith('frame-rate:')) props.onSetFrameRate(event.slice('frame-rate:'.length) as RemoteDesktopFrameRate);
    else if (event.startsWith('capture-precision:')) props.onSetCapturePrecision(event.slice('capture-precision:'.length) as RemoteDesktopCapturePrecision);
    else if (event.startsWith('transport:')) props.onToggleTransport(event.slice('transport:'.length) as RemoteDesktopTransportKey);
  };
  return <MenuView actions={actions} onPressAction={({ nativeEvent }) => select(nativeEvent.event)} title={t('remoteDesktop.settings')}>
    {props.children ?? <Pressable accessibilityLabel={t('remoteDesktop.settings')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
      <Icon color={colors.primary} name="ellipsis-horizontal" size={22} />
    </Pressable>}
  </MenuView>;
}

function transportSFSymbol(key: RemoteDesktopTransportKey): MenuAction['image'] {
  return key === 'p2p' ? 'bolt.fill' : key === 'turn' ? 'arrow.left.arrow.right' : 'cloud.fill';
}

function resolutionLabel(value: RemoteDesktopResolution, t: ReturnType<typeof useI18n>['t']) {
  return value === 'auto' ? t('remoteDesktop.auto') : value.toUpperCase();
}

const styles = StyleSheet.create({
  trigger: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  pressed: { opacity: 0.62 },
});
