import { Button, Column, FieldGroup, Host, Row, Text, TextInput } from '@expo/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { ApprovalDetailBodyProps } from './approval-detail-body-types';
import {
  approvalActions,
  approvalDetailFields,
  type ApprovalDetailField,
} from './approval-detail-model';
import { confirmDanger } from './confirm-action';

export function ApprovalDetailBody(props: ApprovalDetailBodyProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [freeTextKey, setFreeTextKey] = useState(0);
  const fields = approvalDetailFields(props.item, t);
  const actions = approvalActions(props.item, t);
  const story = props.item.type === 'story-decision' ? props.item.decision : undefined;
  const canSubmitStory = Boolean(props.optionId || props.response.trim());

  return <View style={[styles.root, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 12) }]}>
    <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={styles.host}>
      <FieldGroup style={{ backgroundColor: colors.background }}>
        <FieldGroup.Section title={t('approvalCenter.details')} titleUppercase>
          {fields.map((field) => <FieldValue field={field} key={`${field.key}:${field.value}`} />)}
        </FieldGroup.Section>

        {story ? <FieldGroup.Section title={t('approvalCenter.field.decision')}>
          {story.options?.map((option) => {
            const selected = props.optionId === option.id;
            return <Row alignment="center" key={option.id} onPress={() => {
              setFreeTextKey((current) => current + 1);
              props.onOption(option.id);
              props.onResponse('');
            }} spacing={10}>
              <Text textStyle={{ color: selected ? colors.primary : colors.textMuted, fontSize: 18 }}>{selected ? '✓' : '○'}</Text>
              <Column spacing={2}>
                <Text textStyle={{ color: colors.text, fontSize: 15 }}>{option.label}</Text>
                {option.description ? <Text textStyle={{ color: colors.textMuted, fontSize: 12 }}>{option.description}</Text> : null}
              </Column>
            </Row>;
          })}
          {story.allowFreeText ? <TextInput
            key={`free-text-${freeTextKey}`}
            multiline
            onChangeText={(value: string) => {
              props.onResponse(value);
              props.onOption(undefined);
            }}
            placeholder={t('stories.decisionFreeTextPlaceholder')}
          /> : null}
        </FieldGroup.Section> : null}

        {props.failed && props.errorText ? <FieldGroup.Section>
          <Text textStyle={{ color: colors.error, fontSize: 13 }}>{props.errorText}</Text>
        </FieldGroup.Section> : null}

        {props.busy ? <FieldGroup.Section>
          <Text textStyle={{ color: colors.textMuted, fontSize: 13 }}>{t('approvalCenter.submitting')}</Text>
        </FieldGroup.Section> : null}

        <FieldGroup.Section>
          {story ? <Button
            disabled={props.busy || props.sourceUnavailable || !canSubmitStory}
            label={t(props.retryStory ? 'approvalCenter.retryDecision' : 'approvalCenter.submit')}
            onPress={props.onSubmitStory}
          /> : actions.slice(0, 3).map((action) => {
            const actionDisabled = props.busy || props.sourceUnavailable || (props.roleUnavailable && action.decision === 'approve');
            return <Button
              disabled={actionDisabled}
              key={action.key}
              label={action.label}
              onPress={() => {
                if (!action.decision) return;
                if (action.danger) confirmDanger(action.label, t('common.cancel'), () => props.onDecision(action.decision!));
                else props.onDecision(action.decision);
              }}
              variant={action.danger ? 'outlined' : 'text'}
            />;
          })}
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  </View>;
}

function FieldValue({ field }: { field: ApprovalDetailField }) {
  const { colors } = useMobileTheme();
  return <Column spacing={4}>
    <Text textStyle={{ color: colors.textMuted, fontSize: 12 }}>{field.label}</Text>
    <Text textStyle={{ color: colors.text, fontSize: 14 }}>{field.value}</Text>
  </Column>;
}

const styles = {
  host: { flex: 1 },
  root: { flex: 1 },
} as const;
