import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { ApprovalInlineActions } from './ApprovalInlineActions';
import type { ApprovalDetailBodyProps } from './approval-detail-body-types';
import { approvalDetailFields } from './approval-detail-model';

export function ApprovalDetailBody(props: ApprovalDetailBodyProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 12 }]} keyboardShouldPersistTaps="handled">
    <ApprovalFields item={props.item} />
    {props.item.type === 'story-decision' ? <StoryDecisionAnswer
      decision={props.item.decision}
      onOption={props.onOption}
      onResponse={props.onResponse}
      optionId={props.optionId}
      response={props.response}
    /> : null}
    {props.failed && props.errorText ? <Text accessibilityLiveRegion="polite" style={[styles.error, { color: colors.error }]}>{props.errorText}</Text> : null}
    {props.busy ? <View style={styles.busyRow}><ActivityIndicator color={colors.primary} size="small" /><Text accessibilityLiveRegion="polite" style={[styles.meta, { color: colors.textMuted }]}>{t('approvalCenter.submitting')}</Text></View> : null}
    <View style={styles.actions}>
      {props.item.type === 'story-decision' ? <Pressable
        accessibilityRole="button"
        disabled={props.busy || props.sourceUnavailable || (!props.optionId && !props.response.trim())}
        onPress={props.onSubmitStory}
        style={[styles.primaryAction, { backgroundColor: colors.primary, opacity: props.busy || props.sourceUnavailable || (!props.optionId && !props.response.trim()) ? 0.45 : 1 }]}
      >
        <Text style={styles.primaryActionText}>{t(props.retryStory ? 'approvalCenter.retryDecision' : 'approvalCenter.submit')}</Text>
      </Pressable> : <ApprovalInlineActions
        disabled={props.busy || props.sourceUnavailable}
        item={props.item}
        onDecision={props.onDecision}
        onOpen={() => undefined}
        roleUnavailable={props.roleUnavailable}
      />}
    </View>
  </ScrollView>;
}

function ApprovalFields({ item }: { item: ApprovalDetailBodyProps['item'] }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const fields = approvalDetailFields(item, t);
  return <View style={styles.fields}>
    {fields.map((field) => <View key={`${field.key}:${field.value}`} style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{field.label}</Text>
      <Text selectable style={[styles.fieldValue, { color: colors.text }]}>{field.value}</Text>
    </View>)}
  </View>;
}

function StoryDecisionAnswer({ decision, onOption, onResponse, optionId, response }: {
  decision: Extract<ApprovalDetailBodyProps['item'], { type: 'story-decision' }>['decision'];
  onOption(value?: string): void;
  onResponse(value: string): void;
  optionId?: string;
  response: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={styles.answer}>
    {decision.options?.map((option) => <Pressable
      accessibilityLabel={`${option.label}${option.description ? `, ${option.description}` : ''}`}
      accessibilityRole="radio"
      accessibilityState={{ checked: optionId === option.id }}
      key={option.id}
      onPress={() => { onOption(option.id); onResponse(''); }}
      style={[styles.option, { backgroundColor: optionId === option.id ? colors.primarySoft : colors.surface, borderColor: optionId === option.id ? colors.primary : colors.border }]}
    >
      <View style={[styles.radio, { borderColor: optionId === option.id ? colors.primary : colors.textMuted }]}>{optionId === option.id ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}</View>
      <View style={styles.optionCopy}><Text style={[styles.optionTitle, { color: colors.text }]}>{option.label}</Text>{option.description ? <Text style={[styles.optionDescription, { color: colors.textMuted }]}>{option.description}</Text> : null}</View>
    </Pressable>)}
    {decision.allowFreeText ? <TextInput
      accessibilityLabel={t('stories.decisionFreeTextPlaceholder')}
      multiline
      onChangeText={(value) => { onResponse(value); onOption(undefined); }}
      placeholder={t('stories.decisionFreeTextPlaceholder')}
      placeholderTextColor={colors.textPlaceholder}
      style={[styles.freeText, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
      textAlignVertical="top"
      value={response}
    /> : null}
  </View>;
}

const styles = StyleSheet.create({
  actions: { gap: 10, marginTop: 8 },
  answer: { gap: 10 },
  busyRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  content: { gap: 18, paddingHorizontal: 18, paddingTop: 18 },
  error: { fontSize: 13, lineHeight: 19 },
  field: { gap: 4 },
  fieldLabel: { fontSize: 12, lineHeight: 17 },
  fieldValue: { fontSize: 14, lineHeight: 20 },
  fields: { gap: 14 },
  freeText: { borderRadius: 12, borderWidth: 1, fontSize: 15, lineHeight: 21, minHeight: 110, padding: 12 },
  meta: { fontSize: 12, lineHeight: 17 },
  option: { alignItems: 'flex-start', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 52, padding: 12 },
  optionCopy: { flex: 1, gap: 2 },
  optionDescription: { fontSize: 13, lineHeight: 18 },
  optionTitle: { fontSize: 14, lineHeight: 19 },
  primaryAction: { alignItems: 'center', borderRadius: 12, justifyContent: 'center', minHeight: 48, paddingHorizontal: 16 },
  primaryActionText: { color: '#ffffff', fontSize: 15, fontWeight: '600', lineHeight: 20 },
  radio: { alignItems: 'center', borderRadius: 9, borderWidth: 1.5, height: 18, justifyContent: 'center', marginTop: 1, width: 18 },
  radioDot: { borderRadius: 5, height: 10, width: 10 },
});
