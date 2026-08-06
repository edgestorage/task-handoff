import { Button, HStack, Host, Menu } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';
import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';

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
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const iconButton = (isDisabled: boolean) => [buttonStyle('borderless'), controlSize('regular'), labelStyle('iconOnly'), disabled(isDisabled)];
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ height: 38, width: 104 }}>
    <HStack spacing={0}>
      <Menu label={t('composer.addAttachment')} systemImage="plus.circle" modifiers={[buttonStyle('borderless'), controlSize('regular'), labelStyle('iconOnly'), tint(colors.primary)]}>
        <Button label={t('composer.photo')} systemImage="photo" modifiers={[disabled(props.imageDisabled)]} onPress={props.onAddImage} />
        <Button label={t('composer.deviceFile')} systemImage="paperclip" modifiers={[disabled(props.fileDisabled)]} onPress={props.onAddFile} />
        <Button label={t('composer.workspaceFile')} systemImage="folder" modifiers={[disabled(props.runtimeFileDisabled)]} onPress={props.onAddRuntimeFile} />
      </Menu>
      <Menu label={permissionLabel(props.permissionMode, t)} systemImage={permissionIcon(props.permissionMode)} modifiers={[buttonStyle('borderless'), controlSize('small'), props.permissionMode === 'full-access' ? tint(colors.error) : tint(colors.primary)]}>
        <Button label={t('composer.askBeforeChanges')} systemImage="hand.raised" onPress={() => props.onPermissionModeChange('ask')} />
        <Button label={t('composer.autoReview')} systemImage="checkmark.shield" onPress={() => props.onPermissionModeChange('auto-review')} />
        <Button role="destructive" label={t('composer.fullAccess')} systemImage="exclamationmark.shield" onPress={() => props.onPermissionModeChange('full-access')} />
      </Menu>
      {props.showInterrupt ? <Button label={t('composer.interrupt')} systemImage="stop.circle.fill" modifiers={[...iconButton(Boolean(props.interruptDisabled)), tint(colors.error)]} onPress={props.onInterrupt} /> : null}
    </HStack>
  </Host>;
}

export function NativePrimaryButton({ busy, disabled: isDisabled, label, systemImage, onPress }: { busy?: boolean; disabled?: boolean; label: string; systemImage: 'play.fill'; onPress(): void }) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ height: 52, width: '100%' }}>
    <Button label={busy ? t('composer.resuming') : label} systemImage={busy ? 'hourglass' : systemImage} modifiers={[buttonStyle('borderedProminent'), controlSize('large'), disabled(Boolean(isDisabled))]} onPress={onPress} />
  </Host>;
}

function permissionLabel(mode: AiSessionPermissionMode, t: Translate) {
  return mode === 'ask' ? t('composer.ask') : mode === 'auto-review' ? t('composer.autoReview') : t('composer.fullAccess');
}

function permissionIcon(mode: AiSessionPermissionMode): 'hand.raised' | 'checkmark.shield' | 'exclamationmark.shield' {
  return mode === 'ask' ? 'hand.raised' : mode === 'auto-review' ? 'checkmark.shield' : 'exclamationmark.shield';
}
