import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';
import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

type ComposerToolbarProps = {
  permissionMode: AiSessionPermissionMode;
  imageDisabled: boolean;
  fileDisabled: boolean;
  runtimeFileDisabled: boolean;
  interruptDisabled?: boolean;
  showInterrupt: boolean;
  onAddImage(): void;
  onAddFile(): void;
  onAddRuntimeFile(): void;
  onPermissionModeChange(mode: AiSessionPermissionMode): void;
  onInterrupt(): void;
};

export function SessionComposerToolbar(props: ComposerToolbarProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const chooseAttachment = () => Alert.alert(t('composer.addAttachment'), undefined, [
    { text: t('composer.photo'), onPress: props.onAddImage },
    { text: t('composer.deviceFile'), onPress: props.onAddFile },
    { text: t('composer.workspaceFile'), onPress: props.onAddRuntimeFile },
    { text: t('common.cancel'), style: 'cancel' },
  ]);
  const choosePermissionMode = () => Alert.alert(t('composer.permissionMode'), undefined, [
    { text: t('composer.askBeforeChanges'), onPress: () => props.onPermissionModeChange('ask') },
    { text: t('composer.autoReview'), onPress: () => props.onPermissionModeChange('auto-review') },
    { text: t('composer.fullAccess'), onPress: () => props.onPermissionModeChange('full-access') },
    { text: t('common.cancel'), style: 'cancel' },
  ]);
  return <View style={styles.toolbar}>
    <IconButton android="add_circle_outline" ios="plus.circle" label={t('composer.addAttachment')} disabled={props.imageDisabled && props.fileDisabled && props.runtimeFileDisabled} onPress={chooseAttachment} />
    <Pressable accessibilityRole="button" accessibilityLabel={t('composer.permissionModeValue', { mode: permissionLabel(props.permissionMode, t) })} onPress={choosePermissionMode} style={[styles.permission, { backgroundColor: colors.surfaceMuted }]}>
      <SystemIcon android="shield" color={props.permissionMode === 'full-access' ? colors.error : colors.textMuted} ios={permissionIcon(props.permissionMode)} size={15} />
      <Text style={[styles.permissionText, { color: props.permissionMode === 'full-access' ? colors.error : colors.text }]}>{permissionLabel(props.permissionMode, t)}</Text>
      <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={10} />
    </Pressable>
    {props.showInterrupt ? <IconButton android="stop_circle" ios="stop.circle.fill" label={t('composer.interrupt')} color={colors.error} disabled={props.interruptDisabled} onPress={props.onInterrupt} /> : null}
  </View>;
}

export function NativePrimaryButton({ busy, disabled, label, systemImage, onPress }: { busy?: boolean; disabled?: boolean; label: string; systemImage: Parameters<typeof SystemIcon>[0]['ios']; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primaryButton }, disabled && styles.disabled, pressed && styles.pressed]}>
    <SystemIcon android="play_arrow" color="#ffffff" ios={systemImage} size={15} />
    <Text style={styles.primaryButtonText}>{label}</Text>
  </Pressable>;
}

export function permissionLabel(mode: AiSessionPermissionMode, t: Translate) {
  return mode === 'ask' ? t('composer.ask') : mode === 'auto-review' ? t('composer.autoReview') : t('composer.fullAccess');
}

function permissionIcon(mode: AiSessionPermissionMode): Parameters<typeof SystemIcon>[0]['ios'] {
  return mode === 'ask' ? 'hand.raised' : mode === 'auto-review' ? 'checkmark.shield' : 'exclamationmark.shield';
}

function IconButton({ android, ios, label, color, disabled, onPress }: { android: Parameters<typeof SystemIcon>[0]['android']; ios: Parameters<typeof SystemIcon>[0]['ios']; label: string; color?: string; disabled?: boolean; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} hitSlop={5} onPress={onPress} style={({ pressed }) => [styles.iconButton, disabled && styles.disabled, pressed && styles.pressed]}><SystemIcon android={android} color={color || colors.primary} ios={ios} size={20} /></Pressable>;
}

const styles = StyleSheet.create({
  toolbar: { alignItems: 'center', flexDirection: 'row', gap: 1, minHeight: 38 },
  iconButton: { alignItems: 'center', height: 38, justifyContent: 'center', width: 38 },
  permission: { alignItems: 'center', borderRadius: 16, flexDirection: 'row', gap: 5, marginLeft: 2, minHeight: 32, paddingHorizontal: 9 },
  permissionText: { fontSize: 12, fontWeight: '600' },
  primaryButton: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 48, marginTop: 6 },
  primaryButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
});
