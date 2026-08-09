import type { ReactElement } from 'react';
import { Alert } from 'react-native';

import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';

type Trigger = (onPress?: () => void) => ReactElement;

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
  return props.children(() => Alert.alert(props.title, undefined, [
    { text: props.imageLabel, onPress: props.onAddImage },
    { text: props.fileLabel, onPress: props.onAddFile },
    { text: props.runtimeFileLabel, onPress: props.onAddRuntimeFile },
    { text: props.cancelLabel, style: 'cancel' },
  ]));
}

export type PermissionOption = AnchoredSelectOption<AiSessionPermissionMode> & { description: string };

type PermissionMenuProps = {
  title: string;
  cancelLabel: string;
  disabled: boolean;
  mode: AiSessionPermissionMode;
  options: PermissionOption[];
  children: Trigger;
  onChange(mode: AiSessionPermissionMode): void;
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
