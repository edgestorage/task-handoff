import { Button, Form, Host, HStack, Image, Label, LabeledContent, ProgressView, Section, Text, TextField, VStack } from '@expo/ui/swift-ui';
import {
  background,
  buttonStyle,
  disabled as disabledModifier,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listSectionSpacing,
  scrollContentBackground,
  scrollDismissesKeyboard,
  textSelection,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { ApprovalDetailBodyProps } from './approval-detail-body-types';
import {
  approvalDetailFields,
  approvalActions,
  type ApprovalDetailField,
} from './approval-detail-model';
import { confirmDanger } from './confirm-action';

type SystemImage = Parameters<typeof Label>[0]['systemImage'];

// Mirrors the instance detail rows: native inset-grouped sections with a
// leading SF Symbol per field, so approval context reads like iOS Settings.
const FIELD_ICONS: Record<string, SystemImage> = {
  agent: 'sparkles',
  bindScope: 'scope',
  changedFields: 'pencil',
  channel: 'antenna.radiowaves.left.and.right',
  comparisonCode: 'number.square',
  context: 'text.alignleft',
  controlPlane: 'server.rack',
  credentialId: 'key',
  decision: 'questionmark.bubble',
  device: 'iphone',
  expires: 'clock',
  fingerprint: 'touchid',
  instance: 'shippingbox',
  instanceScope: 'shippingbox',
  loginPolicy: 'key',
  node: 'server.rack',
  nodeScope: 'server.rack',
  operation: 'gearshape',
  permissionIds: 'lock.shield',
  port: 'network',
  question: 'questionmark.circle',
  request: 'doc.text',
  revision: 'number',
  roleIds: 'person.badge.key',
  session: 'bubble.left.and.bubble.right',
  status: 'checkmark.circle',
  story: 'book',
  target: 'scope',
  targetVersion: 'tag',
  workspace: 'folder',
};

export function ApprovalDetailBody(props: ApprovalDetailBodyProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const fields = approvalDetailFields(props.item, t);
  const actions = approvalActions(props.item, t);
  const story = props.item.type === 'story-decision' ? props.item.decision : undefined;
  const [freeTextKey, setFreeTextKey] = useState(0);
  const secondaryText = [font({ size: 13 }), foregroundStyle('secondary'), textSelection(true)];
  const canSubmitStory = Boolean(props.optionId || props.response.trim());
  const submitDisabled = props.busy || props.sourceUnavailable || !canSubmitStory;

  return <View style={[styles.root, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 12) }]}>
    <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={styles.host}>
      <Form modifiers={[listSectionSpacing('compact'), scrollContentBackground('hidden'), background(colors.background), tint(colors.primary), scrollDismissesKeyboard('interactively')]}>
        <Section title={t('approvalCenter.details').toLocaleUpperCase()}>
          {fields.map((field) => <ValueRow field={field} key={`${field.key}:${field.value}`} modifiers={secondaryText} />)}
        </Section>

        {story ? <Section title={t('approvalCenter.field.decision')}>
          {story.options?.map((option) => {
            const selected = props.optionId === option.id;
            return <Button
              key={option.id}
              modifiers={[buttonStyle('plain'), frame({ maxWidth: Infinity, alignment: 'leading' })]}
              onPress={() => {
                setFreeTextKey((current) => current + 1);
                props.onOption(option.id);
                props.onResponse('');
              }}
            >
              <HStack spacing={10}>
                <Image color={selected ? colors.primary : colors.textMuted} size={18} systemName={selected ? 'checkmark.circle.fill' : 'circle'} />
                <VStack alignment="leading" spacing={3} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
                  <Text modifiers={[font({ textStyle: 'body' })]}>{option.label}</Text>
                  {option.description ? <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary')]}>{option.description}</Text> : null}
                </VStack>
              </HStack>
            </Button>;
          })}
          {story.allowFreeText ? <TextField
            axis="vertical"
            key={`free-text-${freeTextKey}`}
            onTextChange={(value) => {
              props.onResponse(value);
              props.onOption(undefined);
            }}
            placeholder={t('stories.decisionFreeTextPlaceholder')}
            modifiers={[lineLimit({ min: 3, max: 8 })]}
          /> : null}
        </Section> : null}

        {props.failed && props.errorText ? <Section>
          <Label title={props.errorText} systemImage="exclamationmark.triangle.fill" modifiers={[foregroundStyle(colors.error)]} />
        </Section> : null}

        {props.busy ? <Section>
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[foregroundStyle('secondary')]}>{t('approvalCenter.submitting')}</Text>
          </HStack>
        </Section> : null}

        <Section>
          {story ? <Button
            label={t(props.retryStory ? 'approvalCenter.retryDecision' : 'approvalCenter.submit')}
            systemImage="paperplane"
            onPress={props.onSubmitStory}
            modifiers={[disabledModifier(submitDisabled)]}
          /> : actions.slice(0, 3).map((action) => {
            const actionDisabled = props.busy || props.sourceUnavailable || (props.roleUnavailable && action.decision === 'approve');
            return <Button
              key={action.key}
              label={action.label}
              role={action.danger ? 'destructive' : undefined}
              systemImage={action.decision === 'approve' || action.decision === 'allow' ? 'checkmark.circle' : action.decision === 'skip' ? 'arrow.uturn.forward' : 'xmark.circle'}
              onPress={() => {
                if (!action.decision) return;
                if (action.danger) confirmDanger(action.label, t('common.cancel'), () => props.onDecision(action.decision!));
                else props.onDecision(action.decision);
              }}
              modifiers={[disabledModifier(actionDisabled)]}
            />;
          })}
        </Section>
      </Form>
    </Host>
  </View>;
}

function ValueRow({ field, modifiers }: {
  field: ApprovalDetailField;
  modifiers: NonNullable<Parameters<typeof Text>[0]['modifiers']>;
}) {
  return <LabeledContent label={<Label title={field.label} systemImage={FIELD_ICONS[field.key] ?? 'info.circle'} />}>
    <Text modifiers={modifiers}>{field.value}</Text>
  </LabeledContent>;
}

const styles = {
  host: { flex: 1 },
  root: { flex: 1 },
} as const;
