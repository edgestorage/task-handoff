import { Button, Host, Menu, RNHostView } from '@expo/ui/swift-ui';
import { disabled as disabledModifier } from '@expo/ui/swift-ui/modifiers';
import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

import { AnchoredSelectMenu } from '../components/AnchoredSelectMenu';
import { useMobileTheme } from '../components/theme';

type Trigger = (onPress?: () => void) => React.ReactElement;

type PermissionOption = {
  value: AiSessionPermissionMode;
  label: string;
  description: string;
  systemImage: 'hand.raised' | 'checkmark.shield' | 'exclamationmark.shield';
  danger?: boolean;
};

type AttachmentMenuProps = {
  title: string;
  cancelLabel: string;
  imageLabel: string;
  fileLabel: string;
  runtimeFileLabel: string;
  imageDisabled: boolean;
  fileDisabled: boolean;
  runtimeFileDisabled: boolean;
  children: Trigger;
  onAddImage(): void;
  onAddFile(): void;
  onAddRuntimeFile(): void;
};

export function AttachmentMenu(props: AttachmentMenuProps) {
  const { colors, dark } = useMobileTheme();
  const allDisabled = props.imageDisabled && props.fileDisabled && props.runtimeFileDisabled;
  return <Host colorScheme={dark ? 'dark' : 'light'} ignoreSafeArea="all" matchContents seedColor={colors.primary}>
    <Menu label={<RNHostView matchContents>{props.children()}</RNHostView>} modifiers={[disabledModifier(allDisabled)]}>
      <Button label={props.imageLabel} systemImage="photo" modifiers={[disabledModifier(props.imageDisabled)]} onPress={props.onAddImage} />
      <Button label={props.fileLabel} systemImage="paperclip" modifiers={[disabledModifier(props.fileDisabled)]} onPress={props.onAddFile} />
      <Button label={props.runtimeFileLabel} systemImage="folder" modifiers={[disabledModifier(props.runtimeFileDisabled)]} onPress={props.onAddRuntimeFile} />
    </Menu>
  </Host>;
}

type PermissionMenuProps = {
  title: string;
  cancelLabel: string;
  disabled: boolean;
  mode: PermissionOption['value'];
  options: PermissionOption[];
  children: Trigger;
  onChange(mode: PermissionOption['value']): void;
};

export function PermissionMenu(props: PermissionMenuProps) {
  return <AnchoredSelectMenu
    cancelLabel={props.cancelLabel}
    disabled={props.disabled}
    onSelect={props.onChange}
    options={props.options}
    selectedValue={props.mode}
    title={props.title}
  >{props.children}</AnchoredSelectMenu>;
}
