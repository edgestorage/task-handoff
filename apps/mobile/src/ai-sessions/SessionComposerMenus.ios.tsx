import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Button, Host, Menu, RNHostView } from '@expo/ui/swift-ui';
import { disabled as disabledModifier } from '@expo/ui/swift-ui/modifiers';
import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup } from '@task-handoff/control-plane-client';

import { AnchoredSelectMenu } from '../components/AnchoredSelectMenu';
import { useMobileTheme } from '../components/theme';
import { modelGroupSubtitle, reasoningEfforts, type FormatModelGroupSummary } from './model-settings-menu';

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

type ModelSettingsMenuActionInput = Pick<ModelSettingsMenuProps,
  'formatModelGroupSummary' | 'modelGroups' | 'modelSelection' | 'provider' | 'reasoningEffort' | 'reasoningEnabled' | 'reasoningTitle'
> & { imageColor: string; selectedImageColor: string };

export function modelSettingsMenuActions(input: ModelSettingsMenuActionInput): MenuAction[] {
  const modelActions = input.modelGroups.map((group, groupIndex): MenuAction => {
    const selectedModel = input.modelSelection?.modelEntityId === group.modelEntityId
      ? input.modelSelection.modelName
      : undefined;
    const common = {
      image: group.models.length > 1 && selectedModel ? 'checkmark' : 'sparkles',
      imageColor: group.models.length > 1 && selectedModel ? input.selectedImageColor : input.imageColor,
      subtitle: modelGroupSubtitle(group, input.modelSelection, input.formatModelGroupSummary),
      title: group.providerName,
    };
    if (group.models.length === 1) {
      return {
        ...common,
        id: `model:${groupIndex}:0`,
        state: selectedModel === group.models[0].modelName ? 'on' : 'off',
      };
    }
    return {
      ...common,
      subactions: group.models.map((model, modelIndex) => ({
        id: `model:${groupIndex}:${modelIndex}`,
        state: selectedModel === model.modelName ? 'on' : 'off',
        title: model.modelName,
      })),
    };
  });
  if (!input.reasoningEnabled) return modelActions;
  return [...modelActions, {
    displayInline: true,
    subactions: [{
      image: 'brain',
      imageColor: input.imageColor,
      subtitle: input.reasoningEffort,
      subactions: reasoningEfforts
        .filter((effort) => input.provider === 'codex' || effort !== 'ultra')
        .map((effort) => ({ id: `reasoning:${effort}`, state: input.reasoningEffort === effort ? 'on' : 'off', title: effort })),
      title: input.reasoningTitle,
    }],
    title: '',
  }];
}

export function ModelSettingsMenu(props: ModelSettingsMenuProps) {
  const { colors, dark } = useMobileTheme();
  if (props.disabled) return props.children();
  const actions = modelSettingsMenuActions({
    formatModelGroupSummary: props.formatModelGroupSummary,
    imageColor: colors.textMuted,
    selectedImageColor: colors.primary,
    modelGroups: props.modelGroups,
    modelSelection: props.modelSelection,
    provider: props.provider,
    reasoningEffort: props.reasoningEffort,
    reasoningEnabled: props.reasoningEnabled,
    reasoningTitle: props.reasoningTitle,
  });
  const select = (id: string) => {
    if (id.startsWith('reasoning:')) {
      props.onReasoningChange(id.slice('reasoning:'.length) as AiSessionReasoningEffort);
      return;
    }
    const match = /^model:(\d+):(\d+)$/.exec(id);
    if (!match) return;
    const model = props.modelGroups[Number(match[1])]?.models[Number(match[2])];
    if (model) props.onModelChange({ modelEntityId: model.modelEntityId, modelName: model.modelName });
  };
  return <MenuView
    actions={actions}
    onPressAction={(event) => select(event.nativeEvent.event)}
    themeVariant={dark ? 'dark' : 'light'}
    title={props.title}
  >{props.children()}</MenuView>;
}
