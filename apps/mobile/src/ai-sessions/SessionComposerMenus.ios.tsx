import { Alert } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Button, Host, Menu, RNHostView } from '@expo/ui/swift-ui';
import { disabled as disabledModifier } from '@expo/ui/swift-ui/modifiers';
import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from '@task-handoff/protocol/ai-sessions';
import type { AiSessionModelGroup, AiSessionModelOption } from '@task-handoff/control-plane-client';

import { AnchoredSelectMenu } from '../components/AnchoredSelectMenu';
import { useMobileTheme } from '../components/theme';
import { modelGroupSubtitle, reasoningEfforts, type FormatModelGroupSummary, type ModelSettingsMenuHint } from './model-settings-menu';
import { modelSelectionFromOption, sameModelSelection } from './model-selection';

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
  noModelHint?: ModelSettingsMenuHint;
  children: Trigger;
  onModelChange(selection: AiSessionModelSelection): void;
  onReasoningChange(effort: AiSessionReasoningEffort): void;
};

type ModelSettingsMenuActionInput = Pick<ModelSettingsMenuProps,
  'formatModelGroupSummary' | 'modelGroups' | 'modelSelection' | 'provider' | 'reasoningEffort' | 'reasoningEnabled' | 'reasoningTitle' | 'noModelHint'
> & { imageColor: string; selectedImageColor: string };

export const NO_MODEL_HINT_ACTION_ID = 'no-model-hint';

export function modelSettingsMenuActions(input: ModelSettingsMenuActionInput): MenuAction[] {
  const isSelected = (model: AiSessionModelOption) =>
    input.modelSelection ? sameModelSelection(model, input.modelSelection) : false;
  // 移动端没有模型设置，空目录时把菜单第一项留给"回控制面板配置"的提示。
  const hintActions: MenuAction[] = input.noModelHint ? [{
    id: NO_MODEL_HINT_ACTION_ID,
    image: 'gearshape',
    imageColor: input.imageColor,
    title: input.noModelHint.label,
  }] : [];
  const modelActions = input.modelGroups.map((group, groupIndex): MenuAction => {
    const groupHasSelected = group.models.some(isSelected);
    const common = {
      image: group.models.length > 1 && groupHasSelected ? 'checkmark' : 'sparkles',
      imageColor: group.models.length > 1 && groupHasSelected ? input.selectedImageColor : input.imageColor,
      subtitle: modelGroupSubtitle(group, input.modelSelection, input.formatModelGroupSummary),
      title: group.providerName,
    };
    if (group.models.length === 1) {
      return {
        ...common,
        id: `model:${groupIndex}:0`,
        state: isSelected(group.models[0]) ? 'on' : 'off',
      };
    }
    return {
      ...common,
      subactions: group.models.map((model, modelIndex) => ({
        id: `model:${groupIndex}:${modelIndex}`,
        state: isSelected(model) ? 'on' : 'off',
        title: model.modelName,
      })),
    };
  });
  if (!input.reasoningEnabled) return [...hintActions, ...modelActions];
  return [...hintActions, ...modelActions, {
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
    noModelHint: props.noModelHint,
  });
  const select = (id: string) => {
    if (id === NO_MODEL_HINT_ACTION_ID) {
      if (!props.noModelHint) return;
      Alert.alert(props.noModelHint.label, props.noModelHint.description, [
        { text: props.noModelHint.dismissLabel, style: 'cancel' },
      ]);
      return;
    }
    if (id.startsWith('reasoning:')) {
      props.onReasoningChange(id.slice('reasoning:'.length) as AiSessionReasoningEffort);
      return;
    }
    const match = /^model:(\d+):(\d+)$/.exec(id);
    if (!match) return;
    const model = props.modelGroups[Number(match[1])]?.models[Number(match[2])];
    if (model) props.onModelChange(modelSelectionFromOption(model));
  };
  return <MenuView
    actions={actions}
    onPressAction={(event) => select(event.nativeEvent.event)}
    themeVariant={dark ? 'dark' : 'light'}
    title={props.title}
  >{props.children()}</MenuView>;
}
