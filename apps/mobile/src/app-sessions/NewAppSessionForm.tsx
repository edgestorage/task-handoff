import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { controlPlaneLocalFolderDisplayName, type ControlPlaneInstanceResourceEntry, type ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import type { AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { Screen } from '../components/Screen';
import { Icon, type IconName } from '../components/Icon';
import { useAdaptiveContentLayout } from '../components/adaptive-layout';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { instanceSelectOptions } from '../directories/instance-select-options';
import { appLaunchIcon } from './app-launch-icon';

const DEFAULT_WORKSPACE_VALUE = '__default-workspace__';

type Props = {
  instances: readonly ControlPlaneInstanceResourceEntry[];
  nodes: readonly ControlPlaneNodeDirectoryEntry[];
  selectedInstance?: ControlPlaneInstanceResourceEntry;
  apps?: readonly ControlPlaneInstanceResourceEntry['availableApps'][number][];
  selectedAppId: string;
  appsLoading?: boolean;
  folders: readonly ControlPlaneNodeLocalFolder[];
  foldersLoading?: boolean;
  foldersError?: boolean;
  selectedFolderId?: string;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onInstanceChange(value: string): void;
  onAppChange(value: string): void;
  onFolderChange(value?: string): void;
  onRetryFolders?(): void;
  onCreate(): void;
};

export function NewAppSessionForm(props: Props) {
  const { colors } = useMobileTheme();
  const { locale, t } = useI18n();
  const adaptive = useAdaptiveContentLayout(640);
  const apps = props.apps ?? props.selectedInstance?.availableApps ?? [];
  const selectedApp = apps.find((app) => app.id === props.selectedAppId);
  const selectedFolder = props.folders.find((folder) => folder.id === props.selectedFolderId);
  const showFolders = selectedApp?.supportsCwdSelection && props.selectedInstance?.runtime.type === 'local';
  const instanceOptions = instanceSelectOptions(props.instances, props.nodes);
  const node = props.nodes.find((candidate) => candidate.id === props.selectedInstance?.nodeId);
  const folderOptions: AnchoredSelectOption[] = [
    { label: t('appSessions.defaultWorkspace'), description: props.selectedInstance?.workspace.path, systemImage: 'folder', value: DEFAULT_WORKSPACE_VALUE },
    ...props.folders.map((folder) => ({ description: folder.path, label: controlPlaneLocalFolderDisplayName(folder, locale), systemImage: 'folder' as const, value: folder.id })),
  ];
  const unavailable = props.busy || props.disabled;
  const selectorWidth = Math.max(0, adaptive.contentWidth - 32);
  const launchLabel = props.busy ? t('appSessions.creating') : selectedApp ? t('appSessions.launchNamed', { name: selectedApp.name }) : t('appSessions.create');

  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <Screen alwaysBounceVertical={false} automaticallyAdjustKeyboardInsets={false} maxContentWidth={640} contentContainerStyle={styles.screenContent}>
      <View style={styles.intro}>
        <Text accessibilityRole="header" style={[styles.heading, { color: colors.text }]}>{t('appSessions.new')}</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{t('appSessions.newDescription')}</Text>
      </View>
      <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.busy} onSelect={props.onInstanceChange} options={instanceOptions} selectedValue={props.selectedInstance?.id ?? ''} title={t('sessions.instance')}>
        {(onPress) => <SelectionRow width={selectorWidth} disabled={props.busy || !instanceOptions.length} icon="server-outline" label={t('sessions.instance')}
          value={props.selectedInstance?.name || t('sessions.selectInstance')} description={node?.name} onPress={onPress} />}
      </NewSessionContextMenu>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('appSessions.selectApp')}</Text>
        {apps.length ? <View style={styles.appList}>
          {apps.map((app) => {
            const selected = app.id === props.selectedAppId;
            return <Pressable key={app.id} accessibilityLabel={app.name} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled: props.busy }} disabled={props.busy}
              onPress={() => props.onAppChange(app.id)} style={({ pressed }) => [styles.appRow, { backgroundColor: selected ? colors.primarySoft : colors.surface, borderColor: selected ? colors.primary : colors.workbenchCardBorder }, props.busy && styles.disabled, pressed && styles.pressed]}>
              <View style={[styles.appIcon, { backgroundColor: selected ? colors.surface : colors.surfaceInset }]}><Icon color={selected ? colors.primary : colors.textMuted} name={appLaunchIcon(app.id)} size={23} /></View>
              <View style={styles.rowText}>
                <Text style={[styles.rowValue, { color: colors.text }]}>{app.name}</Text>
                <Text style={[styles.secondary, { color: colors.textMuted }]}>{t(app.kind === 'tty' ? 'appSessions.kindTerminal' : app.kind === 'web' ? 'appSessions.kindWeb' : 'appSessions.kindDesktop')}</Text>
              </View>
              <Icon color={selected ? colors.primary : colors.border} name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={22} />
            </Pressable>;
          })}
        </View> : !props.appsLoading && !props.error ? <Text style={[styles.description, { color: colors.textMuted }]}>{t('appSessions.noApps')}</Text> : null}
        {props.appsLoading ? <View accessibilityLiveRegion="polite" style={styles.status}><ActivityIndicator color={colors.textMuted} /><Text style={[styles.secondary, { color: colors.textMuted }]}>{t('appSessions.checkingApps')}</Text></View> : null}
      </View>

      {showFolders ? <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('sessions.folder')}</Text>
        <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.busy || props.foldersLoading || props.foldersError}
          onSelect={(value) => props.onFolderChange(value === DEFAULT_WORKSPACE_VALUE ? undefined : value)} options={folderOptions} selectedValue={props.selectedFolderId ?? DEFAULT_WORKSPACE_VALUE} title={t('sessions.folder')}>
          {(onPress) => <SelectionRow width={selectorWidth} disabled={props.busy || props.foldersLoading || props.foldersError} icon="folder-outline" label={t('sessions.folder')}
            value={selectedFolder ? controlPlaneLocalFolderDisplayName(selectedFolder, locale) : t('appSessions.defaultWorkspace')}
            description={selectedFolder?.path || props.selectedInstance?.workspace.path} onPress={onPress} />}
        </NewSessionContextMenu>
        {props.foldersLoading ? <View accessibilityLiveRegion="polite" style={styles.status}><ActivityIndicator color={colors.textMuted} /><Text style={[styles.secondary, { color: colors.textMuted }]}>{t('sessions.loadingFolders')}</Text></View> : null}
        {props.foldersError ? <View accessibilityLiveRegion="polite" style={styles.status}>
          <Text style={[styles.statusText, styles.secondary, { color: colors.error }]}>{t('appSessions.foldersError')}</Text>
          <Pressable accessibilityRole="button" disabled={props.busy} accessibilityState={{ disabled: props.busy }} onPress={props.onRetryFolders} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}><Text style={[styles.secondary, { color: colors.primary }]}>{t('common.retry')}</Text></Pressable>
        </View> : null}
      </View> : null}
      {props.error ? <View accessibilityLiveRegion="polite" style={[styles.guidance, { backgroundColor: colors.surfaceInset }]}><Icon color={colors.textMuted} name="information-circle-outline" size={20} /><Text style={[styles.statusText, styles.description, { color: colors.textMuted }]}>{props.error}</Text></View> : null}
    </Screen>
    <SafeAreaView edges={['bottom']} style={[styles.footer, { backgroundColor: colors.surface, borderTopColor: colors.workbenchCardBorder }]}>
      <View style={[styles.footerContent, { paddingLeft: 16 + adaptive.contentInsets.left, paddingRight: 16 + adaptive.contentInsets.right }]}>
        <Pressable accessibilityLabel={launchLabel} accessibilityRole="button" accessibilityState={{ disabled: unavailable, busy: props.busy }} disabled={unavailable} onPress={props.onCreate}
          style={({ pressed }) => [styles.createButton, { backgroundColor: colors.primaryButton }, unavailable && styles.disabled, pressed && styles.pressed]}>
          {props.busy ? <ActivityIndicator color="#fff" /> : <Icon color="#fff" name="play" size={18} />}
          <Text style={styles.createLabel}>{launchLabel}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  </View>;
}

function SelectionRow({ disabled, icon, label, value, description, width, onPress }: { disabled?: boolean; icon: IconName; label: string; value: string; description?: string; width: number; onPress?: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={`${label}: ${value}`} accessibilityHint={description} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.contextRow, { width, backgroundColor: colors.surface, borderColor: colors.workbenchCardBorder }, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon color={colors.textMuted} name={icon} size={20} />
    <View style={styles.rowText}>
      <Text style={[styles.rowValue, { color: colors.text }]}>{value}</Text>
      {description ? <Text numberOfLines={2} style={[styles.secondary, { color: colors.textMuted }]}>{description}</Text> : null}
    </View>
    <Icon color={colors.textMuted} name="chevron-down" size={14} />
  </Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1 }, screenContent: { paddingTop: 24, paddingBottom: 24, gap: 24 },
  intro: { gap: 8 }, heading: { fontSize: 24, fontWeight: '500', lineHeight: 30 }, description: { fontSize: 14, lineHeight: 21 },
  section: { gap: 10 }, sectionTitle: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  appList: { gap: 8 }, appRow: { alignItems: 'center', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 12, minHeight: 76, padding: 14 },
  appIcon: { alignItems: 'center', borderRadius: 12, height: 44, justifyContent: 'center', width: 44 }, rowText: { flex: 1, gap: 3 },
  contextRow: { alignItems: 'center', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, minHeight: 64, padding: 14 },
  rowValue: { fontSize: 15, fontWeight: '500', lineHeight: 21 }, secondary: { fontSize: 12, lineHeight: 18 },
  status: { alignItems: 'center', flexDirection: 'row', gap: 10 }, statusText: { flex: 1 }, retry: { justifyContent: 'center', minHeight: 44, minWidth: 44, paddingHorizontal: 8 },
  guidance: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 10, padding: 14 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth }, footerContent: { paddingVertical: 12 },
  createButton: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 10, justifyContent: 'center', minHeight: 50, paddingHorizontal: 16, paddingVertical: 12 },
  createLabel: { color: '#fff', flexShrink: 1, fontSize: 16, fontWeight: '500', lineHeight: 22, textAlign: 'center' },
  disabled: { opacity: 0.4 }, pressed: { opacity: 0.72 },
});
