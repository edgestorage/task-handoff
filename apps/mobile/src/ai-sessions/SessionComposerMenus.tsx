import type { ReactElement } from 'react';
import { Alert } from 'react-native';

import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup } from '@task-handoff/control-plane-client';
import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { modelGroupSubtitle, reasoningEfforts, type FormatModelGroupSummary } from './model-settings-menu';

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
    ...(!props.imageDisabled ? [{ text: props.imageLabel, onPress: props.onAddImage }] : []),
    ...(!props.fileDisabled ? [{ text: props.fileLabel, onPress: props.onAddFile }] : []),
    ...(!props.runtimeFileDisabled ? [{ text: props.runtimeFileLabel, onPress: props.onAddRuntimeFile }] : []),
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

type ModelSettingsMenuProps = {
  title: string;
  reasoningTitle: string;
  cancelLabel: string;
  disabled: boolean;
  formatModelGroupSummary: FormatModelGroupSummary;
  modelGroups: AiSessionModelGroup[];
  modelSelection?: AiSessionModelSelection;
  reasoningEffort?: AiSessionReasoningEffort;
  provider?: string;
  reasoningEnabled: boolean;
  children: Trigger;
  onModelChange(selection: AiSessionModelSelection): void;
  onReasoningChange(effort: AiSessionReasoningEffort): void;
};

const checkedLabel = (label: string, selected: boolean) => `${selected ? '\u2713 ' : ''}${label}`;

export function ModelSettingsMenu(props: ModelSettingsMenuProps) {
  const chooseModel = (group: AiSessionModelGroup) => {
    if (group.models.length === 1) return props.onModelChange({ modelEntityId: group.models[0].modelEntityId, modelName: group.models[0].modelName });
    Alert.alert(group.providerName, undefined, [
      ...group.models.map((model) => ({
        text: checkedLabel(model.modelName, props.modelSelection?.modelEntityId === model.modelEntityId && props.modelSelection.modelName === model.modelName),
        onPress: () => props.onModelChange({ modelEntityId: model.modelEntityId, modelName: model.modelName }),
      })),
      { text: props.cancelLabel, style: 'cancel' as const },
    ]);
  };
  const chooseReasoning = () => Alert.alert(props.reasoningTitle, undefined, [
    ...reasoningEfforts.filter((effort) => props.provider === 'codex' || effort !== 'ultra').map((effort) => ({ text: checkedLabel(effort, props.reasoningEffort === effort), onPress: () => props.onReasoningChange(effort) })),
    { text: props.cancelLabel, style: 'cancel' as const },
  ]);
  return props.children(props.disabled ? undefined : () => Alert.alert(props.title, undefined, [
    ...props.modelGroups.map((group) => ({
      text: `${group.providerName} · ${modelGroupSubtitle(group, props.modelSelection, props.formatModelGroupSummary)}`,
      onPress: () => chooseModel(group),
    })),
    ...(props.reasoningEnabled ? [{ text: `${props.reasoningTitle}${props.reasoningEffort ? ` · ${props.reasoningEffort}` : ''}`, onPress: chooseReasoning }] : []),
    { text: props.cancelLabel, style: 'cancel' as const },
  ]));
}
