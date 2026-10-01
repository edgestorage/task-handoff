import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { MobileNewWorktreeSelection } from '../repository/worktree-selection';
import { NewSessionBranchPicker, type BranchPickerBranch } from './NewSessionBranchPicker';

type NewWorktreeDialogProps = {
  branches: BranchPickerBranch[];
  busy?: boolean;
  busyLabel?: string;
  defaultStartRef?: string;
  description: string;
  initialSelection?: MobileNewWorktreeSelection;
  confirmLabel: string;
  title: string;
  visible: boolean;
  onCancel(): void;
  onConfirm(selection: MobileNewWorktreeSelection): void;
};

export function NewWorktreeDialog(props: NewWorktreeDialogProps) {
  return <Modal animationType="fade" onRequestClose={props.onCancel} transparent visible={props.visible}>
    {props.visible ? <NewWorktreeDialogBody {...props} /> : null}
  </Modal>;
}

function NewWorktreeDialogBody(props: NewWorktreeDialogProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const initial = props.initialSelection;
  const preferredStartRef = props.branches.find((branch) => branch.name === 'main')?.name
    || props.branches.find((branch) => branch.name === 'master')?.name
    || props.defaultStartRef
    || 'HEAD';
  const [mode, setMode] = useState<'existing-branch' | 'new-branch'>(initial?.mode || 'existing-branch');
  const [branchName, setBranchName] = useState(initial?.mode === 'existing-branch'
    ? initial.branchName
    : props.branches.find((branch) => branch.worktreeSelectable)?.name || '');
  const [newBranchName, setNewBranchName] = useState(initial?.mode === 'new-branch' ? initial.branchName : '');
  const [startRef, setStartRef] = useState(initial?.mode === 'new-branch' ? initial.startRef : preferredStartRef);
  const selectedBranch = props.branches.find((branch) => branch.name === branchName && branch.worktreeSelectable);
  const canConfirm = !props.busy && (mode === 'existing-branch' ? Boolean(selectedBranch) : Boolean(newBranchName.trim() && startRef.trim()));

  const confirm = () => {
    if (!canConfirm) return;
    if (mode === 'existing-branch') {
      if (!selectedBranch) return;
      props.onConfirm({ mode: 'existing-branch', branchName: selectedBranch.name });
      return;
    }
    props.onConfirm({ mode: 'new-branch', branchName: newBranchName.trim(), startRef: startRef.trim() });
  };

  return <Pressable onPress={props.onCancel} style={styles.backdrop}>
      <Pressable onPress={(event) => event.stopPropagation()} style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{props.title}</Text>
          <Pressable accessibilityLabel={t('common.cancel')} accessibilityRole="button" hitSlop={8} onPress={props.onCancel}>
            <SystemIcon android="close" color={colors.textMuted} ios="xmark" size={17} />
          </Pressable>
        </View>
        <Text style={[styles.description, { color: colors.textMuted }]}>{props.description}</Text>
        <View style={[styles.modes, { backgroundColor: colors.surfaceMuted }]}>
          {(['existing-branch', 'new-branch'] as const).map((candidate) => <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: mode === candidate }}
            disabled={props.busy}
            key={candidate}
            onPress={() => setMode(candidate)}
            style={[styles.mode, mode === candidate && { backgroundColor: colors.surface }]}
          >
            <SystemIcon android={candidate === 'existing-branch' ? 'account_tree' : 'add'} color={mode === candidate ? colors.text : colors.textMuted} ios={candidate === 'existing-branch' ? 'arrow.triangle.branch' : 'plus'} size={14} />
            <Text style={[styles.modeLabel, { color: mode === candidate ? colors.text : colors.textMuted }]}>{t(candidate === 'existing-branch' ? 'sessions.existingBranch' : 'sessions.newBranch')}</Text>
          </Pressable>)}
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" style={styles.body}>
          {mode === 'existing-branch' ? <>
            <View style={styles.field}>
              <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{t('sessions.branch')}</Text>
              <NewSessionBranchPicker
                branches={props.branches}
                disabled={props.busy}
                mode="worktree"
                onSelect={setBranchName}
                selectedValue={branchName}
                title={t('sessions.branch')}
              >
                {(onPress) => <Pressable accessibilityRole="button" disabled={props.busy} onPress={onPress} style={[styles.input, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
                  <Text numberOfLines={1} style={[styles.inputText, { color: branchName ? colors.text : colors.textMuted }]}>{branchName || t('sessions.selectBranch')}</Text>
                  <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={12} />
                </Pressable>}
              </NewSessionBranchPicker>
              {selectedBranch?.worktreeCheckout === 'detached' ? <Text style={[styles.hint, { color: colors.textMuted }]}>{t('sessions.worktreeDetachedHint')}</Text> : null}
            </View>
          </> : <>
            <View style={styles.field}>
              <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{t('sessions.worktreeBranch')}</Text>
              <TextInput
                accessibilityLabel={t('sessions.worktreeBranch')}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!props.busy}
                maxLength={255}
                onChangeText={setNewBranchName}
                placeholder={t('sessions.worktreeBranch')}
                placeholderTextColor={colors.textMuted}
                style={[styles.textField, { backgroundColor: colors.surfaceMuted, borderColor: colors.border, color: colors.text }]}
                testID="new-worktree-branch-name"
                value={newBranchName}
              />
            </View>
            <View style={styles.field}>
              <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{t('sessions.worktreeStartRef')}</Text>
              <NewSessionBranchPicker
                branches={props.branches}
                disabled={props.busy}
                mode="current-folder"
                onSelect={setStartRef}
                selectedValue={startRef}
                title={t('sessions.worktreeStartRef')}
              >
                {(onPress) => <Pressable accessibilityRole="button" disabled={props.busy} onPress={onPress} style={[styles.input, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} testID="new-worktree-start-ref">
                  <Text numberOfLines={1} style={[styles.inputText, { color: colors.text }]}>{startRef}</Text>
                  <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={12} />
                </Pressable>}
              </NewSessionBranchPicker>
            </View>
          </>}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable accessibilityRole="button" disabled={props.busy} onPress={props.onCancel} style={({ pressed }) => [styles.footerButton, { borderColor: colors.border }, pressed && styles.pressed]}>
            <Text style={[styles.footerLabel, { color: colors.text }]}>{t('common.cancel')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm }}
            disabled={!canConfirm}
            onPress={confirm}
            style={({ pressed }) => [styles.footerButton, styles.confirmButton, { backgroundColor: colors.primaryButton }, (!canConfirm || props.busy) && styles.disabled, pressed && styles.pressed]}
          >
            <Text style={[styles.footerLabel, styles.confirmLabel]}>{props.busy ? props.busyLabel || t('sessions.creatingWorktree') : props.confirmLabel}</Text>
          </Pressable>
        </View>
      </Pressable>
    </Pressable>;
}

const styles = StyleSheet.create({
  backdrop: { alignItems: 'center', backgroundColor: 'rgba(0, 0, 0, 0.48)', flex: 1, justifyContent: 'center', padding: 20 },
  panel: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, maxHeight: '82%', maxWidth: 460, overflow: 'hidden', width: '100%' },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  title: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  description: { fontSize: 13, lineHeight: 18, paddingBottom: 12, paddingHorizontal: 16 },
  modes: { borderRadius: 10, flexDirection: 'row', gap: 4, marginHorizontal: 16, padding: 3 },
  mode: { alignItems: 'center', borderRadius: 8, flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 34 },
  modeLabel: { fontSize: 13, fontWeight: '500', lineHeight: 18 },
  body: { paddingHorizontal: 16 },
  field: { gap: 6, paddingTop: 14 },
  fieldLabel: { fontSize: 12, lineHeight: 16 },
  input: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, justifyContent: 'space-between', minHeight: 40, paddingHorizontal: 12 },
  inputText: { flex: 1, fontSize: 14, lineHeight: 20 },
  textField: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 14, lineHeight: 20, minHeight: 40, paddingHorizontal: 12, paddingVertical: 10 },
  hint: { fontSize: 12, lineHeight: 17 },
  footer: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', padding: 16 },
  footerButton: { alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 38, paddingHorizontal: 16 },
  confirmButton: { borderWidth: 0 },
  footerLabel: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
  confirmLabel: { color: '#fff' },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.75 },
});
