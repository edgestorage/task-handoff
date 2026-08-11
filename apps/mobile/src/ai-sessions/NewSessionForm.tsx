import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Hand, Plus, ShieldAlert, ShieldCheck } from 'lucide-react-native';
import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import {
  SESSION_COMPOSER_ACTION_ICON_SIZE,
  SESSION_COMPOSER_ACTION_RADIUS,
  SESSION_COMPOSER_ACTION_SIZE,
  SESSION_COMPOSER_ATTACHMENT_ICON_SIZE,
  SESSION_COMPOSER_EXPANDED_RADIUS,
  SESSION_COMPOSER_TOOL_SIZE,
  SESSION_COMPOSER_TOOLBAR_HEIGHT,
  sessionComposerPermissionIconSize,
} from './composer-metrics';
import type { NewSessionFormProps } from './new-session-types';
import { NewSessionBranchPicker } from './NewSessionBranchPicker';
import { NewSessionContextMenu } from './NewSessionContextMenu';
import { AttachmentMenu } from './SessionComposerMenus';

const DEFAULT_WORKSPACE_VALUE = '__default-workspace__';

export function NewSessionForm(props: NewSessionFormProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const workspaceMode = props.workspaceMode ?? 'current-folder';
  const selectedAgentName = props.selectedInstance?.availableAgents.find((agent) => agent.id === props.selectedAgent)?.name;
  const selectedFolder = props.folders.find((folder) => folder.id === props.selectedFolderId);
  const folderName = selectedFolder?.name || t('appSessions.defaultWorkspace');
  const instanceOptions = newSessionInstanceOptions(props.instances, props.nodes);
  const folderOptions: AnchoredSelectOption[] = [
    { label: t('appSessions.defaultWorkspace'), systemImage: 'folder', value: DEFAULT_WORKSPACE_VALUE },
    ...props.folders.map((folder) => ({ label: folder.name, description: folder.path, systemImage: 'folder' as const, value: folder.id })),
  ];
  const agentOptions: AnchoredSelectOption[] = (props.selectedInstance?.availableAgents ?? []).map((agent) => ({ label: agent.name, systemImage: 'sparkles', value: agent.id }));
  const gitWorkspace = props.workspace?.availability === 'available' && props.workspace.branches.length ? props.workspace : undefined;
  const workspaceModeOptions: AnchoredSelectOption<'current-folder' | 'worktree'>[] = [
    { label: t('sessions.currentFolderMode'), systemImage: 'folder', value: 'current-folder' },
    ...(gitWorkspace?.branches.some((branch) => branch.worktreeSelectable)
      ? [{ label: t('sessions.worktreeMode'), systemImage: 'arrow.triangle.branch' as const, value: 'worktree' as const }]
      : []),
  ];
  const branchOptions: AnchoredSelectOption[] = (gitWorkspace?.branches || [])
    .filter((branch) => workspaceMode === 'worktree' ? branch.worktreeSelectable : branch.currentFolderSelectable)
    .map((branch) => ({
      label: branch.worktreeCheckout === 'detached' && workspaceMode === 'worktree' ? `${branch.name} (${t('sessions.detached')})` : branch.name,
      systemImage: 'arrow.triangle.branch' as const,
      value: branch.name,
    }));
  const selectedBranchLabel = branchOptions.find((option) => option.value === props.selectedBranch)?.label || props.selectedBranch || t('sessions.selectBranch');

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
          <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.busy} onSelect={props.onInstanceChange} options={instanceOptions} selectedValue={props.selectedInstanceId} title={t('sessions.instance')}>
            {(onPress) => <ContextPill disabled={props.busy || !instanceOptions.length} icon={{ android: 'dns', ios: 'server.rack' }} label={props.selectedInstance?.name || t('sessions.selectInstance')} onPress={onPress} />}
          </NewSessionContextMenu>
          <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.busy} onSelect={(value) => props.onFolderChange(value === DEFAULT_WORKSPACE_VALUE ? undefined : value)} options={folderOptions} selectedValue={props.selectedFolderId ?? DEFAULT_WORKSPACE_VALUE} title={t('sessions.folder')}>
            {(onPress) => <ContextPill disabled={props.busy || !folderOptions.length} icon={{ android: 'folder', ios: 'folder' }} label={folderName} onPress={onPress} />}
          </NewSessionContextMenu>
          {gitWorkspace ? <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.busy} onSelect={(value) => props.onWorkspaceModeChange?.(value)} options={workspaceModeOptions} selectedValue={workspaceMode} title={t('sessions.workspaceMode')}>
            {(onPress) => <ContextPill disabled={props.busy || props.workspaceLoading} icon={{ android: 'account_tree', ios: 'arrow.triangle.branch' }} label={workspaceMode === 'worktree' ? t('sessions.worktreeMode') : t('sessions.currentFolderMode')} onPress={onPress} />}
          </NewSessionContextMenu> : null}
          {gitWorkspace ? <NewSessionBranchPicker branches={gitWorkspace.branches} disabled={props.busy || props.workspaceLoading} mode={workspaceMode} onSelect={(value) => props.onBranchChange?.(value)} selectedValue={props.selectedBranch || ''} title={t('sessions.branch')}>
            {(onPress) => <ContextPill disabled={props.busy || props.workspaceLoading || !branchOptions.length} icon={{ android: 'account_tree', ios: 'arrow.triangle.branch' }} label={selectedBranchLabel} onPress={onPress} />}
          </NewSessionBranchPicker> : null}
          <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={props.busy} onSelect={props.onAgentChange} options={agentOptions} selectedValue={props.selectedAgent} title={t('sessions.agent')}>
            {(onPress) => <ContextPill disabled={props.busy || !agentOptions.length} icon={{ android: 'auto_awesome', ios: 'sparkles' }} label={selectedAgentName || t('sessions.selectAgent')} onPress={onPress} />}
          </NewSessionContextMenu>
        </View>

        <TextInput
          accessibilityLabel={t('sessions.prompt')}
          editable={!props.busy}
          multiline
          onChangeText={props.onMessageChange}
          placeholder={t('sessions.promptPlaceholder')}
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primary}
          style={[styles.prompt, { color: colors.text }]}
          value={props.message}
        />

        {props.attachments.length ? <View style={styles.attachments}>
          {props.attachments.map((attachment) => <View key={attachment.id} style={[styles.attachment, { backgroundColor: colors.surfaceMuted }]}>
            <SystemIcon android={attachment.kind === 'image' ? 'image' : 'description'} color={colors.textMuted} ios={attachment.kind === 'image' ? 'photo' : 'doc'} size={15} />
            <Text numberOfLines={1} style={[styles.attachmentName, { color: colors.text }]}>{attachment.name}</Text>
            <Pressable accessibilityLabel={t('workspace.removeAttachment', { name: attachment.name })} accessibilityRole="button" accessibilityState={{ disabled: props.busy }} disabled={props.busy} hitSlop={8} onPress={() => props.onRemoveAttachment(attachment.id)} style={props.busy ? styles.disabled : undefined}>
              <SystemIcon android="close" color={colors.textMuted} ios="xmark.circle.fill" size={17} />
            </Pressable>
          </View>)}
        </View> : null}

        <View style={styles.toolbar}>
          <View style={styles.leadingTools}>
            <AttachmentMenu
              cancelLabel={t('common.cancel')}
              fileDisabled={props.busy}
              fileLabel={t('composer.deviceFile')}
              imageDisabled={props.busy}
              imageLabel={t('composer.photo')}
              onAddFile={props.onAddFile}
              onAddImage={props.onAddImage}
              onAddRuntimeFile={() => undefined}
              runtimeFileDisabled
              runtimeFileLabel={t('composer.workspaceFile')}
              title={t('composer.addAttachment')}
            >
              {(onPress) => <Pressable
                accessibilityLabel={t('composer.addAttachment')}
                accessibilityRole="button"
                accessibilityState={{ disabled: props.busy }}
                disabled={props.busy}
                hitSlop={4}
                onPress={onPress}
                style={({ pressed }) => [styles.toolButton, props.busy && styles.disabled, pressed && styles.pressed]}
              >
                <Plus color={colors.textMuted} size={SESSION_COMPOSER_ATTACHMENT_ICON_SIZE} strokeWidth={1.9} />
              </Pressable>}
            </AttachmentMenu>
            {props.selectedAgent === 'codex' ? <PermissionButton disabled={props.busy} mode={props.permissionMode} onChange={props.onPermissionModeChange} /> : null}
          </View>
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

export function newSessionInstanceOptions(instances: readonly ControlPlaneInstanceDirectoryEntry[], nodes: readonly ControlPlaneNodeDirectoryEntry[]): AnchoredSelectOption[] {
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  return instances.map((instance) => ({ label: instance.name, description: nodeNames.get(instance.nodeId) || instance.nodeId, systemImage: 'server.rack', value: instance.id }));
}

function ContextPill({ disabled, icon, label, onPress }: { disabled?: boolean; icon: { android: 'dns' | 'auto_awesome' | 'folder' | 'account_tree'; ios: 'server.rack' | 'sparkles' | 'folder' | 'arrow.triangle.branch' }; label: string; onPress?: () => void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.contextPill, { backgroundColor: colors.surfaceMuted }, disabled && styles.disabled, pressed && styles.pressed]}>
    <SystemIcon android={icon.android} color={colors.textMuted} ios={icon.ios} size={15} />
    <Text numberOfLines={1} style={[styles.contextLabel, { color: colors.text }]}>{label}</Text>
    <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={11} />
  </Pressable>;
}

function PermissionButton({ disabled, mode, onChange }: { disabled?: boolean; mode: NewSessionFormProps['permissionMode']; onChange(value: NewSessionFormProps['permissionMode']): void }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const options: AnchoredSelectOption<NewSessionFormProps['permissionMode']>[] = [
    { value: 'ask', label: t('composer.ask'), description: t('composer.askDescription'), systemImage: 'hand.raised' },
    { value: 'auto-review', label: t('composer.autoReview'), description: t('composer.autoReviewDescription'), systemImage: 'checkmark.shield' },
    { value: 'full-access', label: t('composer.fullAccess'), description: t('composer.fullAccessDescription'), systemImage: 'exclamationmark.shield', danger: true },
  ];
  const selected = options.find((option) => option.value === mode) || options[0];
  const PermissionIcon = mode === 'ask' ? Hand : mode === 'auto-review' ? ShieldCheck : ShieldAlert;
  return <AnchoredSelectMenu cancelLabel={t('common.cancel')} disabled={disabled} onSelect={onChange} options={options} selectedValue={mode} title={t('sessions.permission')}>
    {(onPress) => <Pressable accessibilityLabel={t('composer.permissionModeValue', { mode: selected.label })} accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.permissionButton, disabled && styles.disabled, pressed && styles.pressed]}>
      <PermissionIcon color={selected.danger ? colors.error : colors.textMuted} size={sessionComposerPermissionIconSize(mode)} strokeWidth={1.8} />
      <Text style={[styles.permissionLabel, { color: selected.danger ? colors.error : colors.textMuted }]}>{selected.label}</Text>
      <SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={10} />
    </Pressable>}
  </AnchoredSelectMenu>;
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
  toolbar: { alignItems: 'center', flexDirection: 'row', height: SESSION_COMPOSER_TOOLBAR_HEIGHT, justifyContent: 'space-between', marginHorizontal: -6, paddingBottom: 6 },
  leadingTools: { alignItems: 'center', flexDirection: 'row' },
  toolButton: { alignItems: 'center', height: SESSION_COMPOSER_TOOL_SIZE, justifyContent: 'center', width: SESSION_COMPOSER_TOOL_SIZE },
  permissionButton: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 40, paddingHorizontal: 4 },
  permissionLabel: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  sendButton: { alignItems: 'center', borderRadius: SESSION_COMPOSER_ACTION_RADIUS, height: SESSION_COMPOSER_ACTION_SIZE, justifyContent: 'center', width: SESSION_COMPOSER_ACTION_SIZE },
  attachments: { gap: 6 },
  attachment: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  attachmentName: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  error: { borderRadius: 12, fontSize: 13, lineHeight: 19, padding: 12 },
});
