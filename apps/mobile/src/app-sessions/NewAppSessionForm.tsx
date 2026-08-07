import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ControlPlaneInstanceResourceEntry, ControlPlaneNodeLocalFolder } from '@task-handoff/control-plane-client';

import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';

type Props = {
  instances: readonly ControlPlaneInstanceResourceEntry[];
  selectedInstance?: ControlPlaneInstanceResourceEntry;
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
  const selectedApp = props.selectedInstance?.availableApps.find((app) => app.id === props.selectedAppId);
  const selectedFolder = props.folders.find((folder) => folder.id === props.selectedFolderId);
  const showFolders = selectedApp?.supportsCwdSelection && props.selectedInstance?.runtime.type === 'local';

  return <Screen>
    <View style={styles.intro}>
      <Text style={[styles.heading, { color: colors.text }]}>{t('appSessions.new')}</Text>
      <Text style={[styles.description, { color: colors.textMuted }]}>{t('appSessions.newDescription')}</Text>
    </View>

    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <SelectionRow
        icon={{ android: 'dns', ios: 'server.rack' }}
        label={t('sessions.instance')}
        value={props.selectedInstance?.name || t('sessions.selectInstance')}
        onPress={() => choose(t('sessions.instance'), props.instances.map((instance) => ({ label: instance.name, value: instance.id })), props.onInstanceChange, t)}
      />
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <SelectionRow
        icon={{ android: 'apps', ios: 'app' }}
        label={t('appSessions.app')}
        value={selectedApp?.name || t('appSessions.selectApp')}
        onPress={() => choose(t('appSessions.app'), (props.selectedInstance?.availableApps ?? []).map((app) => ({ label: app.name, value: app.id })), props.onAppChange, t)}
      />
      {showFolders ? <>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <SelectionRow
          icon={{ android: 'folder', ios: 'folder' }}
          label={t('sessions.folder')}
          value={selectedFolder?.name || t('appSessions.defaultWorkspace')}
          onPress={() => chooseOptional(t('sessions.folder'), [{ label: t('appSessions.defaultWorkspace'), value: undefined }, ...props.folders.map((folder) => ({ label: `${folder.name} — ${folder.path}`, value: folder.id }))], props.onFolderChange, t)}
        />
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

function SelectionRow({ icon, label, value, onPress }: { icon: { android: 'dns' | 'apps' | 'folder'; ios: 'server.rack' | 'app' | 'folder' }; label: string; value: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
    <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android={icon.android} color={colors.primary} ios={icon.ios} size={19} /></View>
    <View style={styles.rowText}>
      <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.rowValue, { color: colors.text }]}>{value}</Text>
    </View>
    <SystemIcon android="chevron_right" color={colors.textMuted} ios="chevron.right" size={13} />
  </Pressable>;
}

function choose(title: string, options: { label: string; value: string }[], onSelect: (value: string) => void, t: Translate) {
  Alert.alert(title, undefined, [...options.map((option) => ({ text: option.label, onPress: () => onSelect(option.value) })), { text: t('common.cancel'), style: 'cancel' }]);
}

function chooseOptional(title: string, options: { label: string; value?: string }[], onSelect: (value?: string) => void, t: Translate) {
  Alert.alert(title, undefined, [...options.map((option) => ({ text: option.label, onPress: () => onSelect(option.value) })), { text: t('common.cancel'), style: 'cancel' }]);
}

const styles = StyleSheet.create({
  intro: { alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 20, paddingHorizontal: 20 },
  heading: { fontSize: 28, fontWeight: '700', letterSpacing: -0.6, lineHeight: 34, textAlign: 'center' },
  description: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingHorizontal: 14 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 72 },
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
