import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '../components/Icon';
import { MenuView, type MenuAction } from '../components/MenuView';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { canDisableTransport, type RemoteDesktopFrameRate, type RemoteDesktopResolution, type RemoteDesktopTransportKey } from './preferences';
import type { RemoteDesktopSnapshot } from './types';

type Props = {
  children?: ReactNode;
  onChooseTarget(): void;
  onDisconnect(): void;
  onSetFrameRate(value: RemoteDesktopFrameRate): void;
  onSetResolution(value: RemoteDesktopResolution): void;
  onToggleTransport(key: RemoteDesktopTransportKey): void;
  snapshot: RemoteDesktopSnapshot;
};

const resolutions: readonly RemoteDesktopResolution[] = ['auto', '1080p', '720p', '540p', '360p'];
const frameRates: readonly RemoteDesktopFrameRate[] = ['auto', '60', '30', '24', '15'];
const transports: readonly RemoteDesktopTransportKey[] = ['p2p', 'turn', 'websocket'];

export function RemoteDesktopSettingsMenu(props: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { snapshot } = props;
  const transportActions: MenuAction[] = transports.map((key) => {
    const enabled = snapshot.transportAvailability[key];
    return {
      id: `transport:${key}`,
      title: `${transportLabel(key, t)} · ${transportStateLabel(key, snapshot, t)}`,
      image: transportSFSymbol(key),
      state: enabled ? 'on' : 'off',
      attributes: { disabled: enabled && !canDisableTransport(snapshot.transportAvailability, key) },
    };
  });
  const actions: MenuAction[] = [
    {
      id: 'choose-target',
      title: snapshot.target.kind === 'window' ? t('remoteDesktop.singleWindow') : t('remoteDesktop.entireDesktop'),
      image: 'macwindow',
    },
    {
      id: 'resolution',
      title: t('remoteDesktop.resolution'),
      image: 'arrow.up.left.and.arrow.down.right',
      subactions: resolutions.map((value) => ({
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
    if (event === 'choose-target') props.onChooseTarget();
    else if (event === 'disconnect') props.onDisconnect();
    else if (event.startsWith('resolution:')) props.onSetResolution(event.slice('resolution:'.length) as RemoteDesktopResolution);
    else if (event.startsWith('frame-rate:')) props.onSetFrameRate(event.slice('frame-rate:'.length) as RemoteDesktopFrameRate);
    else if (event.startsWith('transport:')) props.onToggleTransport(event.slice('transport:'.length) as RemoteDesktopTransportKey);
  };
  return <MenuView actions={actions} onPressAction={({ nativeEvent }) => select(nativeEvent.event)} title={t('remoteDesktop.settings')}>
    {props.children ?? <Pressable accessibilityLabel={t('remoteDesktop.settings')} accessibilityRole="button" hitSlop={10} style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
      <Icon color={colors.primary} name="ellipsis-horizontal" size={22} />
    </Pressable>}
  </MenuView>;
}

export function transportLabel(key: RemoteDesktopTransportKey, t: ReturnType<typeof useI18n>['t']) {
  return key === 'p2p' ? t('remoteDesktop.transportP2P') : key === 'turn' ? t('remoteDesktop.transportTurn') : t('remoteDesktop.transportWebSocket');
}

export function transportIcon(key: RemoteDesktopTransportKey) {
  return key === 'p2p' ? 'flash-outline' as const : key === 'turn' ? 'swap-horizontal-outline' as const : 'cloud-outline' as const;
}

function transportSFSymbol(key: RemoteDesktopTransportKey): MenuAction['image'] {
  return key === 'p2p' ? 'bolt.fill' : key === 'turn' ? 'arrow.left.arrow.right' : 'cloud.fill';
}

function transportStateLabel(key: RemoteDesktopTransportKey, snapshot: RemoteDesktopSnapshot, t: ReturnType<typeof useI18n>['t']) {
  if (!snapshot.transportAvailability[key]) return t('remoteDesktop.transportUnavailable');
  const state = snapshot.transportStates[key];
  if (state === 'active' || snapshot.path === key) return t('remoteDesktop.transportActive');
  if (state === 'failed') return t('remoteDesktop.transportFailed');
  return t('remoteDesktop.transportStandby');
}

function resolutionLabel(value: RemoteDesktopResolution, t: ReturnType<typeof useI18n>['t']) {
  return value === 'auto' ? t('remoteDesktop.auto') : value.toUpperCase();
}

const styles = StyleSheet.create({
  trigger: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  pressed: { opacity: 0.62 },
});
