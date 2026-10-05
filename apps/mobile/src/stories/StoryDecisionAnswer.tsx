import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { StoryDecision } from '@task-handoff/protocol/stories';

import { useMobileTheme } from '../components/theme';
import { mobileWebType } from '../components/mobile-web-typography';
import { useI18n } from '../i18n';
import type { StoryDecisionAnswerInput } from './story-decision';

/**
 * 决策答复只有一套交互：Story 决策区与会话内提示共用，提交状态机留在各自的调用方。
 */
export function StoryDecisionAnswer({
  decision,
  disabled = false,
  busy = false,
  onCancel,
  onSubmit,
}: {
  decision: StoryDecision;
  disabled?: boolean;
  busy?: boolean;
  onCancel(): void;
  onSubmit(input: StoryDecisionAnswerInput): void;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [optionId, setOptionId] = useState('');
  const [replyPicked, setReplyPicked] = useState(false);
  const [response, setResponse] = useState('');
  // 只允许自由文本的决策没有可选项，回复就是唯一答案，直接展开。
  const replySelected = replyPicked || (!decision.options.length && decision.allowFreeText);
  const canSubmit = Boolean(optionId) || (replySelected && Boolean(response.trim()));

  const submit = () => {
    if (!canSubmit || disabled || busy) return;
    onSubmit({
      ...(optionId ? { optionId } : {}),
      ...(replySelected && response.trim() ? { response: response.trim() } : {}),
    });
  };

  return (
    <View style={styles.answer}>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        {decision.options.map((option, index) => {
          const selected = optionId === option.id;
          return (
            <Pressable
              accessibilityLabel={option.label}
              accessibilityRole="radio"
              accessibilityState={{ disabled: disabled || busy, selected }}
              disabled={disabled || busy}
              key={option.id}
              onPress={() => { setOptionId(option.id); setReplyPicked(false); }}
              style={({ pressed }) => [
                styles.choice,
                { borderColor: 'transparent' },
                selected && { backgroundColor: colors.primarySoft, borderColor: colors.primary },
                (disabled || busy) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.choiceIndex, { backgroundColor: selected ? colors.primary : colors.surfaceMuted }]}>
                <Text style={[styles.choiceIndexText, { color: selected ? colors.surface : colors.textMuted }]}>{index + 1}</Text>
              </View>
              <Text style={[styles.choiceLabel, { color: colors.text }]}>{option.label}</Text>
            </Pressable>
          );
        })}
        {decision.allowFreeText ? (
          <Pressable
            accessibilityLabel={t('stories.decisionReplyOption')}
            accessibilityRole="radio"
            accessibilityState={{ disabled: disabled || busy, selected: replySelected }}
            disabled={disabled || busy}
            onPress={() => { setOptionId(''); setReplyPicked(true); }}
            style={({ pressed }) => [
              styles.choice,
              { borderColor: 'transparent' },
              replySelected && { backgroundColor: colors.primarySoft, borderColor: colors.primary },
              (disabled || busy) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.choiceIndex, { backgroundColor: replySelected ? colors.primary : colors.surfaceMuted }]}>
              <Text style={[styles.choiceIndexText, { color: replySelected ? colors.surface : colors.textMuted }]}>{decision.options.length + 1}</Text>
            </View>
            <Text style={[styles.choiceLabel, { color: colors.text }]}>{t('stories.decisionReplyOption')}</Text>
          </Pressable>
        ) : null}
      </View>
      {replySelected ? (
        <TextInput
          accessibilityLabel={t('stories.decisionFreeTextPlaceholder')}
          editable={!disabled && !busy}
          multiline
          onChangeText={setResponse}
          placeholder={t('stories.decisionFreeTextPlaceholder')}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.reply, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
          value={response}
        />
      ) : null}
      <View style={styles.buttons}>
        <Pressable
          accessibilityLabel={t('stories.decisionSubmit')}
          accessibilityRole="button"
          accessibilityState={{ disabled: disabled || busy || !canSubmit }}
          disabled={disabled || busy || !canSubmit}
          onPress={submit}
          style={({ pressed }) => [styles.submit, { backgroundColor: colors.primary }, (disabled || busy || !canSubmit) && styles.disabled, pressed && styles.pressed]}
        >
          {busy ? <ActivityIndicator color={colors.surface} size="small" /> : <Text style={[styles.submitText, { color: colors.surface }]}>{t('stories.decisionSubmit')}</Text>}
        </Pressable>
        <Pressable
          accessibilityLabel={t('stories.decisionCancel')}
          accessibilityRole="button"
          accessibilityState={{ disabled: disabled || busy }}
          disabled={disabled || busy}
          onPress={onCancel}
          style={({ pressed }) => [styles.cancel, { backgroundColor: colors.surfaceMuted }, (disabled || busy) && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={[styles.cancelText, { color: colors.textMuted }]}>{t('stories.decisionCancel')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  answer: { gap: 8, minWidth: 0 },
  choices: { gap: 2, minWidth: 0 },
  choice: { alignItems: 'center', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 10, minHeight: 44, paddingHorizontal: 8, paddingVertical: 4 },
  choiceIndex: { alignItems: 'center', borderRadius: 7, height: 22, justifyContent: 'center', width: 22 },
  choiceIndexText: { fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  choiceLabel: { flex: 1, fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine },
  reply: { borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, fontSize: mobileWebType.small, lineHeight: mobileWebType.smallLine, minHeight: 60, paddingHorizontal: 10, paddingVertical: 8, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', gap: 8 },
  submit: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', justifyContent: 'center', minHeight: 38, paddingHorizontal: 14 },
  submitText: { fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  cancel: { alignItems: 'center', borderRadius: 9, justifyContent: 'center', minHeight: 38, paddingHorizontal: 14 },
  cancelText: { fontSize: mobileWebType.small, fontWeight: '500', lineHeight: mobileWebType.smallLine },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
});
