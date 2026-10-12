import type { ReactElement } from 'react';

import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup } from '@task-handoff/control-plane-client';
import { AnchoredSelectMenu, type AnchoredSelectOption } from '../components/AnchoredSelectMenu';
import { FloatingMenuTrigger } from '../components/menu/FloatingMenuTrigger';
import type { FloatingMenuBlock, FloatingMenuPage } from '../components/menu/menu-model';
import { modelGroupSubtitle, reasoningEfforts, type FormatModelGroupSummary, type ModelSettingsMenuHint } from './model-settings-menu';
import { modelSelectionFromOption, sameModelSelection } from './model-selection';

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
  const blocks: FloatingMenuBlock[] = [
    { item: { disabled: props.imageDisabled, icon: 'image', key: 'image', label: props.imageLabel, onPress: props.onAddImage }, key: 'image', type: 'item' },
    { item: { disabled: props.fileDisabled, icon: 'attach_file', key: 'file', label: props.fileLabel, onPress: props.onAddFile }, key: 'file', type: 'item' },
    { item: { disabled: props.runtimeFileDisabled, icon: 'folder', key: 'runtime-file', label: props.runtimeFileLabel, onPress: props.onAddRuntimeFile }, key: 'runtime-file', type: 'item' },
  ];
  const unavailable = props.imageDisabled && props.fileDisabled && props.runtimeFileDisabled;
  return <FloatingMenuTrigger disabled={unavailable} page={unavailable ? null : { blocks, title: props.title }}>{props.children}</FloatingMenuTrigger>;
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
  noModelHint?: ModelSettingsMenuHint;
  children: Trigger;
  onModelChange(selection: AiSessionModelSelection): void;
  onReasoningChange(effort: AiSessionReasoningEffort): void;
};

export function ModelSettingsMenu(props: ModelSettingsMenuProps) {
  const { formatModelGroupSummary, modelGroups, modelSelection, noModelHint, reasoningEffort, reasoningEnabled, reasoningTitle, onModelChange, onReasoningChange } = props;
  const isSelected = (model: AiSessionModelGroup['models'][number]) => (modelSelection ? sameModelSelection(model, modelSelection) : false);
  const blocks: FloatingMenuBlock[] = [];
  if (noModelHint) {
    blocks.push({ item: { disabled: true, icon: 'settings', key: 'no-model-hint', label: noModelHint.label, subtitle: noModelHint.description }, key: 'no-model-hint', type: 'item' });
  }
  modelGroups.forEach((group, groupIndex) => {
    const selectedModel = group.models.find(isSelected);
    const common = {
      icon: group.models.length > 1 && selectedModel ? 'check' as const : 'auto_awesome' as const,
      label: group.providerName,
      subtitle: modelGroupSubtitle(group, modelSelection, formatModelGroupSummary),
    };
    if (group.models.length === 1) {
      blocks.push({ item: { ...common, key: `model:${groupIndex}:0`, onPress: () => onModelChange(modelSelectionFromOption(group.models[0])), selected: isSelected(group.models[0]) }, key: `model:${groupIndex}:0`, type: 'item' });
      return;
    }
    const submenu: FloatingMenuPage = {
      blocks: group.models.map((model, modelIndex) => ({
        item: { key: `model:${groupIndex}:${modelIndex}`, label: model.modelName, onPress: () => onModelChange(modelSelectionFromOption(model)), selected: isSelected(model) },
        key: `model:${groupIndex}:${modelIndex}`,
        type: 'item',
      })),
      title: group.providerName,
    };
    blocks.push({ item: { ...common, key: `model:${groupIndex}`, selected: Boolean(selectedModel), submenu }, key: `model:${groupIndex}`, type: 'item' });
  });
  if (reasoningEnabled) {
    const submenu: FloatingMenuPage = {
      blocks: reasoningEfforts
        .filter((effort) => props.provider === 'codex' || effort !== 'ultra')
        .map((effort) => ({
          item: { key: `reasoning:${effort}`, label: effort, onPress: () => onReasoningChange(effort), selected: reasoningEffort === effort },
          key: `reasoning:${effort}`,
          type: 'item',
        })),
      title: reasoningTitle,
    };
    if (blocks.length) blocks.push({ key: 'reasoning-divider', type: 'divider' });
    blocks.push({ item: { icon: 'psychology', key: 'reasoning', label: reasoningTitle, submenu, subtitle: reasoningEffort }, key: 'reasoning', type: 'item' });
  }
  const page: FloatingMenuPage = { blocks, title: props.title };
  return <FloatingMenuTrigger disabled={props.disabled || !blocks.length} page={props.disabled || !blocks.length ? null : page}>{props.children}</FloatingMenuTrigger>;
}
