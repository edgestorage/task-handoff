import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useI18n } from '../i18n';
import { useMobileTheme } from './theme';

type SessionRenameModalProps = {
  busy: boolean;
  error?: string;
  initialTitle: string;
  onClose(): void;
  onSubmit(title: string): void;
  open: boolean;
};

export function SessionRenameModal({ busy, error, initialTitle, onClose, onSubmit, open }: SessionRenameModalProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialTitle);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(initialTitle);
    setValidationError('');
  }, [initialTitle, open]);

  const submit = () => {
    const title = draft.trim();
    if (title.length > 120) {
      setValidationError(t('sessions.renameTooLong'));
      return;
    }
    if (title === initialTitle.trim()) {
      onClose();
      return;
    }
    setValidationError('');
    onSubmit(title);
  };
  const visibleError = validationError || error;

  return <Modal animationType="fade" onRequestClose={() => !busy && onClose()} transparent visible={open}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.overlay}>
      <Pressable accessibilityLabel={t('common.cancel')} disabled={busy} onPress={onClose} style={styles.backdrop} />
      <View accessibilityViewIsModal style={[styles.dialog, { backgroundColor: colors.surface }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{t('sessions.rename')}</Text>
        <TextInput
          accessibilityLabel={t('sessions.renameLabel')}
          autoFocus
          editable={!busy}
          maxLength={120}
          onChangeText={(value) => { setDraft(value); setValidationError(''); }}
          onSubmitEditing={submit}
          placeholder={t('sessions.renamePlaceholder')}
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          selectTextOnFocus
          style={[styles.input, { borderColor: visibleError ? colors.error : colors.border, color: colors.text }]}
          value={draft}
        />
        {visibleError ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{visibleError}</Text> : null}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
            <Text style={[styles.actionText, { color: colors.textMuted }]}>{t('common.cancel')}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={submit} style={({ pressed }) => [styles.action, busy && styles.disabled, pressed && styles.pressed]}>
            <Text style={[styles.actionText, { color: colors.primary }]}>{busy ? t('sessions.renaming') : t('common.save')}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)', bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
  dialog: { borderRadius: 8, gap: 12, maxWidth: 420, padding: 18, width: '100%' },
  title: { fontSize: 18, fontWeight: '700', lineHeight: 24 },
  input: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 },
  error: { fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  action: { alignItems: 'center', justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  actionText: { fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
});
