import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { controlPlaneLocalFolderDisplayName, type ControlPlaneInstanceResourceEntry, type ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import type { AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { instanceSelectOptions } from '../directories/instance-select-options';
import { appLaunchSystemIcon } from './app-launch-icon';

const DEFAULT_WORKSPACE_VALUE = '__default-workspace__';

type Props = {
  instances: readonly ControlPlaneInstanceResourceEntry[];
  nodes: readonly ControlPlaneNodeDirectoryEntry[];
  selectedInstance?: ControlPlaneInstanceResourceEntry;
  apps?: readonly ControlPlaneInstanceResourceEntry['availableApps'][number][];
  selectedAppId: string;
  folders: readonly ControlPlaneNodeLocalFolder[];
  selectedFolderId?: string;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onInstanceChange(value: string): void;
  onAppChange(value: string): void;
  onFolderChange(value?: string): void;
  onCreate(): void;
};

export function NewAppSessionForm(props: Props) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [selectionRowWidth, setSelectionRowWidth] = useState<number>();
  const apps = props.apps ?? props.selectedInstance?.availableApps ?? [];
  const selectedApp = apps.find((app) => app.id === props.selectedAppId);
  const selectedFolder = props.folders.find((folder) => folder.id === props.selectedFolderId);
  const showFolders = selectedApp?.supportsCwdSelection && props.selectedInstance?.runtime.type === 'local';
  const instanceOptions = instanceSelectOptions(props.instances, props.nodes);
  const appOptions: AnchoredSelectOption[] = apps.map((app) => ({
    label: app.name,
    systemImage: appLaunchSystemIcon(app.id).ios,
    value: app.id,
  }));
  const folderOptions: AnchoredSelectOption[] = [
    { label: t('appSessions.defaultWorkspace'), systemImage: 'folder', value: DEFAULT_WORKSPACE_VALUE },
    ...props.folders.map((folder) => ({ description: folder.path, label: controlPlaneLocalFolderDisplayName(folder), systemImage: 'folder' as const, value: folder.id })),
  ];

  return <Screen alwaysBounceVertical={false} automaticallyAdjustKeyboardInsets={false} contentContainerStyle={styles.screenContent}>
    <View style={styles.intro}>
      <Text style={[styles.heading, { color: colors.text }]}>{t('appSessions.new')}</Text>
      <Text style={[styles.description, { color: colors.textMuted }]}>{t('appSessions.newDescription')}</Text>
    </View>

    <View
      onLayout={(event) => setSelectionRowWidth(event.nativeEvent.layout.width - 28)}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
      testID="new-app-session-selection-card"
    >
      <NewSessionContextMenu cancelLabel={t('common.cancel')} onSelect={props.onInstanceChange} options={instanceOptions} selectedValue={props.selectedInstance?.id ?? ''} title={t('sessions.instance')}>
        {(onPress) => <SelectionRow
          disabled={!instanceOptions.length}
          icon={{ android: 'dns', ios: 'server.rack' }}
          label={t('sessions.instance')}
          value={props.selectedInstance?.name || t('sessions.selectInstance')}
          width={selectionRowWidth}
          onPress={onPress}
        />}
      </NewSessionContextMenu>
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <NewSessionContextMenu cancelLabel={t('common.cancel')} onSelect={props.onAppChange} options={appOptions} selectedValue={props.selectedAppId} title={t('appSessions.app')}>
        {(onPress) => <SelectionRow
          disabled={!appOptions.length}
          icon={appLaunchSystemIcon(selectedApp?.id)}
          label={t('appSessions.app')}
          value={selectedApp?.name || t('appSessions.selectApp')}
          width={selectionRowWidth}
          onPress={onPress}
        />}
      </NewSessionContextMenu>
      {showFolders ? <>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <NewSessionContextMenu
          cancelLabel={t('common.cancel')}
          onSelect={(value) => props.onFolderChange(value === DEFAULT_WORKSPACE_VALUE ? undefined : value)}
          options={folderOptions}
          selectedValue={props.selectedFolderId ?? DEFAULT_WORKSPACE_VALUE}
          title={t('sessions.folder')}
        >
          {(onPress) => <SelectionRow
            icon={{ android: 'folder', ios: 'folder' }}
            label={t('sessions.folder')}
            value={selectedFolder?.name || t('appSessions.defaultWorkspace')}
            width={selectionRowWidth}
            onPress={onPress}
          />}
        </NewSessionContextMenu>
      </> : null}
    </View>

    {props.error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{props.error}</Text> : null}
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onCreate}
      style={({ pressed }) => [styles.createButton, { backgroundColor: colors.primaryButton }, props.disabled && styles.disabled, pressed && styles.pressed]}
    >
      <SystemIcon android={props.busy ? 'hourglass_top' : 'play_arrow'} color="#fff" ios={props.busy ? 'hourglass' : 'play.fill'} size={18} />
      <Text style={styles.createLabel}>{props.busy ? t('appSessions.creating') : t('appSessions.create')}</Text>
    </Pressable>
  </Screen>;
}

function SelectionRow({ disabled, icon, label, value, width, onPress }: { disabled?: boolean; icon: Pick<Parameters<typeof SystemIcon>[0], 'android' | 'ios'>; label: string; value: string; width?: number; onPress?: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable
    accessibilityLabel={`${label}: ${value}`}
    accessibilityRole="button"
    accessibilityState={{ disabled: Boolean(disabled) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.row, width === undefined ? styles.rowBeforeLayout : { width }, disabled && styles.disabled, pressed && styles.pressed]}
  >
    <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android={icon.android} color={colors.primary} ios={icon.ios} size={19} /></View>
    <View style={styles.rowText}>
      <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.rowValue, { color: colors.text }]}>{value}</Text>
    </View>
    <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={13} />
  </Pressable>;
}

const styles = StyleSheet.create({
  screenContent: { alignSelf: 'center', justifyContent: 'center', maxWidth: 640, paddingVertical: 24, width: '100%' },
  intro: { alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 20, paddingHorizontal: 20 },
  heading: { fontSize: 28, fontWeight: '700', letterSpacing: -0.6, lineHeight: 34, textAlign: 'center' },
  description: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingHorizontal: 14 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 72 },
  rowBeforeLayout: { alignSelf: 'stretch' },
  icon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
  rowValue: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  createButton: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50 },
  createLabel: { color: '#fff', fontSize: 16, fontWeight: '700', lineHeight: 22 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  error: { borderRadius: 12, fontSize: 13, lineHeight: 19, padding: 12 },
});
