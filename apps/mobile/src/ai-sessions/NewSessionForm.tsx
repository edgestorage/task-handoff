import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';
import {
  SESSION_COMPOSER_ACTION_ICON_SIZE,
  SESSION_COMPOSER_ACTION_RADIUS,
  SESSION_COMPOSER_ACTION_SIZE,
  SESSION_COMPOSER_EXPANDED_RADIUS,
  SESSION_COMPOSER_TOOLBAR_HEIGHT,
} from './composer-metrics';
import type { NewSessionFormProps } from './new-session-types';

export function NewSessionForm(props: NewSessionFormProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const selectedAgentName = props.selectedInstance?.availableAgents.find((agent) => agent.id === props.selectedAgent)?.name;
  const selectedFolder = props.folders.find((folder) => folder.path === props.cwd);
  const folderName = selectedFolder?.name || pathName(props.cwd) || t('sessions.selectFolder');
  const folderOptions = props.folders.length
    ? props.folders.map((folder) => ({ label: `${folder.name} — ${folder.path}`, value: folder.path }))
    : props.cwd ? [{ label: `${folderName} — ${props.cwd}`, value: props.cwd }] : [];

  return <KeyboardAvoidingView behavior={newSessionKeyboardAvoidingBehavior(Platform.OS)} style={styles.screen} testID="new-session-keyboard-area">
    <Screen
      alwaysBounceVertical={false}
      automaticallyAdjustKeyboardInsets={false}
      contentContainerStyle={[styles.screenContent, { paddingBottom: 24 + (props.visualBalanceInset ?? 0) }]}
      testID="new-session-scroll"
    >
      <View style={styles.intro}>
        <Text style={[styles.heading, { color: colors.text }]}>{t('sessions.startIdea')}</Text>
        <Text style={[styles.description, { color: colors.textMuted }]}>{t('sessions.ideaDescription')}</Text>
      </View>

      <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.contextRow}>
          <ContextPill
            icon={{ android: 'dns', ios: 'server.rack' }}
            label={props.selectedInstance?.name || t('sessions.selectInstance')}
            onPress={() => choose(t('sessions.instance'), props.instances.map((instance) => ({ label: instance.name, value: instance.id })), props.onInstanceChange, t)}
          />
          <ContextPill
            icon={{ android: 'folder', ios: 'folder' }}
            label={folderName}
            onPress={() => choose(t('sessions.folder'), folderOptions, props.onCwdChange, t)}
          />
          <ContextPill
            icon={{ android: 'auto_awesome', ios: 'sparkles' }}
            label={selectedAgentName || 'Choose agent'}
            onPress={() => choose('Agent', (props.selectedInstance?.availableAgents ?? []).map((agent) => ({ label: agent.name, value: agent.id })), props.onAgentChange, t)}
          />
        </View>

        <TextInput
          accessibilityLabel={t('sessions.prompt')}
          multiline
          onChangeText={props.onMessageChange}
          placeholder={t('sessions.promptPlaceholder')}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primary}
          style={[styles.prompt, { color: colors.text }]}
          value={props.message}
        />

        <View style={styles.toolbar}>
          {props.selectedAgent === 'codex' ? <PermissionButton mode={props.permissionMode} onChange={props.onPermissionModeChange} /> : <View />}
          <Pressable
            accessibilityLabel={props.busy ? t('sessions.creating') : t('sessions.create')}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onCreate}
            style={({ pressed }) => [styles.sendButton, { backgroundColor: colors.primaryButton }, props.disabled && styles.disabled, pressed && styles.pressed]}
          >
            <SystemIcon android={props.busy ? 'hourglass_top' : 'arrow_upward'} color="#fff" ios={props.busy ? 'hourglass' : 'arrow.up'} size={SESSION_COMPOSER_ACTION_ICON_SIZE} />
          </Pressable>
        </View>
      </View>
      {props.error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{props.error}</Text> : null}
    </Screen>
  </KeyboardAvoidingView>;
}

function ContextPill({ icon, label, onPress }: { icon: { android: 'dns' | 'auto_awesome' | 'folder'; ios: 'server.rack' | 'sparkles' | 'folder' }; label: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.contextPill, { backgroundColor: colors.surfaceMuted }, pressed && styles.pressed]}>
    <SystemIcon android={icon.android} color={colors.textMuted} ios={icon.ios} size={15} />
    <Text numberOfLines={1} style={[styles.contextLabel, { color: colors.text }]}>{label}</Text>
    <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={11} />
  </Pressable>;
}

function PermissionButton({ mode, onChange }: { mode: NewSessionFormProps['permissionMode']; onChange(value: NewSessionFormProps['permissionMode']): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const label = mode === 'ask' ? t('composer.askBeforeChanges') : mode === 'auto-review' ? t('composer.autoReview') : t('composer.fullAccess');
  return <Pressable
    accessibilityRole="button"
    onPress={() => choose(t('sessions.permission'), [
      { label: t('composer.askBeforeChanges'), value: 'ask' },
      { label: t('composer.autoReview'), value: 'auto-review' },
      { label: t('composer.fullAccess'), value: 'full-access' },
    ], (value) => onChange(value as NewSessionFormProps['permissionMode']), t)}
    style={({ pressed }) => [styles.permissionButton, pressed && styles.pressed]}
  >
    <SystemIcon android="verified_user" color={colors.textMuted} ios="hand.raised" size={16} />
    <Text style={[styles.permissionLabel, { color: colors.textMuted }]}>{label}</Text>
    <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={10} />
  </Pressable>;
}

function choose(title: string, options: { label: string; value: string }[], onSelect: (value: string) => void, t: Translate) {
  Alert.alert(title, undefined, [...options.map((option) => ({ text: option.label, onPress: () => onSelect(option.value) })), { text: t('common.cancel'), style: 'cancel' }]);
}

function pathName(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
}

export function newSessionKeyboardAvoidingBehavior(platform: string): 'padding' | undefined {
  return platform === 'ios' ? 'padding' : undefined;
}

export function newSessionVisualBalanceInset(platform: string, safeAreaTop: number): number {
  if (platform === 'ios') return Math.max(0, safeAreaTop) + 44;
  if (platform === 'android') return Math.max(0, safeAreaTop) + 56;
  return 0;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenContent: { alignSelf: 'center', gap: 16, justifyContent: 'center', maxWidth: 640, paddingVertical: 24, width: '100%' },
  intro: { alignItems: 'center', gap: 8, paddingHorizontal: 20 },
  heading: { fontSize: 28, fontWeight: '700', letterSpacing: -0.6, lineHeight: 34, textAlign: 'center' },
  description: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  composer: { borderRadius: SESSION_COMPOSER_EXPANDED_RADIUS, borderWidth: StyleSheet.hairlineWidth, minHeight: 320, overflow: 'hidden', paddingBottom: 0, paddingHorizontal: 14, paddingTop: 14 },
  contextRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  contextPill: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 6, maxWidth: '100%', minHeight: 38, paddingHorizontal: 11 },
  contextLabel: { flexShrink: 1, fontSize: 14, fontWeight: '600', lineHeight: 20 },
  prompt: { flex: 1, fontSize: 16, lineHeight: 24, minHeight: 176, paddingHorizontal: 4, paddingVertical: 16, textAlignVertical: 'top' },
  toolbar: { alignItems: 'center', flexDirection: 'row', height: SESSION_COMPOSER_TOOLBAR_HEIGHT, justifyContent: 'space-between', marginHorizontal: -2, paddingBottom: 6 },
  permissionButton: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 40, paddingHorizontal: 4 },
  permissionLabel: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  sendButton: { alignItems: 'center', borderRadius: SESSION_COMPOSER_ACTION_RADIUS, height: SESSION_COMPOSER_ACTION_SIZE, justifyContent: 'center', width: SESSION_COMPOSER_ACTION_SIZE },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  error: { borderRadius: 12, fontSize: 13, lineHeight: 19, padding: 12 },
});
