import { Button, HStack, Host, Menu } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';
import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

import { useMobileTheme } from '../components/theme';

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
  const iconButton = (isDisabled: boolean) => [buttonStyle('borderless'), controlSize('regular'), labelStyle('iconOnly'), disabled(isDisabled)];
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ height: 38, width: 104 }}>
    <HStack spacing={0}>
      <Menu label="Add attachment" systemImage="plus.circle" modifiers={[buttonStyle('borderless'), controlSize('regular'), labelStyle('iconOnly'), tint(colors.primary)]}>
        <Button label="Photo" systemImage="photo" modifiers={[disabled(props.imageDisabled)]} onPress={props.onAddImage} />
        <Button label="Device file" systemImage="paperclip" modifiers={[disabled(props.fileDisabled)]} onPress={props.onAddFile} />
        <Button label="Workspace file" systemImage="folder" modifiers={[disabled(props.runtimeFileDisabled)]} onPress={props.onAddRuntimeFile} />
      </Menu>
      <Menu label={permissionLabel(props.permissionMode)} systemImage={permissionIcon(props.permissionMode)} modifiers={[buttonStyle('borderless'), controlSize('small'), props.permissionMode === 'full-access' ? tint(colors.error) : tint(colors.primary)]}>
        <Button label="Ask before changes" systemImage="hand.raised" onPress={() => props.onPermissionModeChange('ask')} />
        <Button label="Auto review" systemImage="checkmark.shield" onPress={() => props.onPermissionModeChange('auto-review')} />
        <Button role="destructive" label="Full access" systemImage="exclamationmark.shield" onPress={() => props.onPermissionModeChange('full-access')} />
      </Menu>
      {props.showInterrupt ? <Button label="Interrupt" systemImage="stop.circle.fill" modifiers={[...iconButton(Boolean(props.interruptDisabled)), tint(colors.error)]} onPress={props.onInterrupt} /> : null}
    </HStack>
  </Host>;
}

export function NativePrimaryButton({ busy, disabled: isDisabled, label, systemImage, onPress }: { busy?: boolean; disabled?: boolean; label: string; systemImage: 'play.fill'; onPress(): void }) {
  const { colors, dark } = useMobileTheme();
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ height: 52, width: '100%' }}>
    <Button label={busy ? 'Resuming…' : label} systemImage={busy ? 'hourglass' : systemImage} modifiers={[buttonStyle('borderedProminent'), controlSize('large'), disabled(Boolean(isDisabled))]} onPress={onPress} />
  </Host>;
}

function permissionLabel(mode: AiSessionPermissionMode) {
  return mode === 'ask' ? 'Ask' : mode === 'auto-review' ? 'Auto review' : 'Full access';
}

function permissionIcon(mode: AiSessionPermissionMode): 'hand.raised' | 'checkmark.shield' | 'exclamationmark.shield' {
  return mode === 'ask' ? 'hand.raised' : mode === 'auto-review' ? 'checkmark.shield' : 'exclamationmark.shield';
}
