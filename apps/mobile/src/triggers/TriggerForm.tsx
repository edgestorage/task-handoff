import { useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import type { ControlPlaneTriggerTemplateInput } from '@task-handoff/protocol/triggers';

import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useI18n, type Translate } from '../i18n';
import { emptyTriggerDraft, triggerDraftCanSubmit, triggerInput, type TriggerFormDraft, type TriggerScheduleKind, type TriggerSourceType } from './model';

type TriggerFormProps = {
  initial?: TriggerFormDraft;
  submitLabel: string;
  onSubmit(input: ControlPlaneTriggerTemplateInput): Promise<void>;
};

type Choice = { label: string; value: string };

export function TriggerForm({ initial = emptyTriggerDraft(), submitLabel, onSubmit }: TriggerFormProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(() => initial.cooldownMs !== '0' || initial.whenBusy !== 'skip' || initial.maxConcurrentRuns !== '1');
  const set = <K extends keyof TriggerFormDraft>(key: K, value: TriggerFormDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const canSubmit = triggerDraftCanSubmit(draft) && !saving;
  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await onSubmit(triggerInput(draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill} testID="trigger-form-keyboard-area">
    <View style={[styles.fill, { backgroundColor: colors.background }]}>
      <Screen contentContainerStyle={styles.screen} testID="trigger-form-scroll">
        <View style={styles.intro}>
          <Text style={[styles.title, { color: colors.text }]}>{t('triggers.form.introTitle')}</Text>
          <Text style={[styles.introText, { color: colors.textMuted }]}>{t('triggers.form.introDescription')}</Text>
        </View>

        <Section title={t('triggers.form.basic')}>
          <Field
            autoCapitalize="sentences"
            label={t('triggers.form.name')}
            maxLength={160}
            onChange={(value) => set('name', value)}
            placeholder={t('triggers.form.namePlaceholder')}
            required
            value={draft.name}
          />
          <Field
            autoCapitalize="sentences"
            label={t('triggers.form.description')}
            maxLength={1000}
            multiline
            onChange={(value) => set('description', value)}
            placeholder={t('triggers.form.descriptionPlaceholder')}
            value={draft.description}
          />
        </Section>

        <Section flush title={t('triggers.form.type')}>
          <View style={styles.sourceChoices}>
            {sourceOptions(t).map((option, index, options) => <SourceChoice
              key={option.value}
              active={draft.sourceType === option.value}
              description={option.description}
              label={option.label}
              last={index === options.length - 1}
              onPress={() => set('sourceType', option.value)}
              type={option.value}
            />)}
          </View>
        </Section>

        <Section title={sourceSectionTitle(draft.sourceType, t)}>
          {draft.sourceType === 'schedule' ? <>
            <SegmentedChoices
              label={t('triggers.form.scheduleMode')}
              onSelect={(value) => set('scheduleKind', value as TriggerScheduleKind)}
              options={scheduleOptions(t)}
              selected={draft.scheduleKind}
            />
            {draft.scheduleKind === 'interval' ? <View style={styles.intervalRow}>
              <Field compact keyboard="number-pad" label={t('triggers.form.interval')} onChange={(value) => set('intervalValue', value)} required value={draft.intervalValue} />
              <SegmentedChoices compact onSelect={(value) => set('intervalUnit', value as TriggerFormDraft['intervalUnit'])} options={intervalUnitOptions(t)} selected={draft.intervalUnit} />
            </View> : <>
              <Field autoCapitalize="none" label={t('triggers.form.time')} maxLength={5} onChange={(value) => set('timeOfDay', value)} placeholder="09:00" required value={draft.timeOfDay} />
              <Field autoCapitalize="none" label={t('triggers.form.timezone')} maxLength={120} onChange={(value) => set('timezone', value)} placeholder="Asia/Shanghai" required value={draft.timezone} />
              {draft.scheduleKind === 'weekly' ? <ChipSelect label={t('triggers.form.weekdays')} onChange={(values) => set('weekdays', values.map(Number))} options={weekdayOptions(t)} selected={draft.weekdays.map(String)} /> : null}
            </>}
          </> : draft.sourceType === 'file-change' ? <>
            <Field autoCapitalize="none" label={t('triggers.form.roots')} maxLength={4096} onChange={(value) => set('roots', value)} placeholder="/workspace" required value={draft.roots} />
            <Field autoCapitalize="none" label={t('triggers.form.globs')} maxLength={500} onChange={(value) => set('globs', value)} placeholder="**/*.ts, **/*.tsx" required value={draft.globs} />
            <Field autoCapitalize="none" label={t('triggers.form.ignore')} maxLength={500} onChange={(value) => set('ignore', value)} placeholder="node_modules/**, .git/**" value={draft.ignore} />
            <Field keyboard="number-pad" label={t('triggers.form.debounce')} onChange={(value) => set('debounceMs', value)} value={draft.debounceMs} />
          </> : <>
            <Field autoCapitalize="none" label={t('triggers.form.agent')} maxLength={80} onChange={(value) => set('agent', value)} placeholder={t('triggers.form.anyAgent')} value={draft.agent} />
            <ChipSelect label={t('triggers.form.statuses')} onChange={(values) => set('statuses', values as TriggerFormDraft['statuses'])} options={statusOptions(t)} selected={draft.statuses} />
            <ChipSelect label={t('triggers.form.phases')} onChange={(values) => set('phases', values as TriggerFormDraft['phases'])} options={phaseOptions(t)} selected={draft.phases} />
          </>}
        </Section>

        <Section title={t('triggers.form.action')}>
          <Field
            autoCapitalize="sentences"
            label={t('triggers.form.prompt')}
            maxLength={20_000}
            multiline
            onChange={(value) => set('promptTemplate', value)}
            placeholder={t('triggers.form.promptPlaceholder')}
            required
            tall
            value={draft.promptTemplate}
          />
        </Section>

        <View style={[styles.advancedCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable
            accessibilityLabel={t('triggers.form.advanced')}
            accessibilityRole="button"
            accessibilityState={{ expanded: advancedOpen }}
            onPress={() => setAdvancedOpen((value) => !value)}
            style={({ pressed }) => [styles.advancedHeader, pressed && styles.pressed]}
          >
            <View style={[styles.advancedIcon, { backgroundColor: colors.surfaceMuted }]}><SystemIcon android="tune" color={colors.primary} ios="slider.horizontal.3" size={18} /></View>
            <View style={styles.advancedCopy}>
              <Text style={[styles.advancedTitle, { color: colors.text }]}>{t('triggers.form.advanced')}</Text>
              <Text style={[styles.advancedDescription, { color: colors.textMuted }]}>{t('triggers.form.advancedDescription')}</Text>
            </View>
            <SystemIcon android={advancedOpen ? 'expand_less' : 'expand_more'} color={colors.textMuted} ios={advancedOpen ? 'chevron.up' : 'chevron.down'} size={14} />
          </Pressable>
          {advancedOpen ? <View style={[styles.advancedFields, { borderTopColor: colors.border }]}>
            <Field keyboard="number-pad" label={t('triggers.form.cooldown')} onChange={(value) => set('cooldownMs', value)} value={draft.cooldownMs} />
            <SegmentedChoices label={t('triggers.form.whenBusy')} onSelect={(value) => set('whenBusy', value as TriggerFormDraft['whenBusy'])} options={busyOptions(t)} selected={draft.whenBusy} />
            <Field keyboard="number-pad" label={t('triggers.form.concurrency')} onChange={(value) => set('maxConcurrentRuns', value)} value={draft.maxConcurrentRuns} />
          </View> : null}
        </View>
      </Screen>

      <View pointerEvents="box-none" style={styles.footerLayer} testID="trigger-form-footer-gradient">
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Svg height="100%" width="100%">
            <Defs>
              <LinearGradient id="trigger-form-footer-fade" x1="0" x2="0" y1="0" y2="100%">
                <Stop offset={0} stopColor={colors.background} stopOpacity={0} />
                <Stop offset={0.34} stopColor={colors.background} stopOpacity={0.86} />
                <Stop offset={1} stopColor={colors.background} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#trigger-form-footer-fade)" height="100%" width="100%" />
          </Svg>
        </View>
        <SafeAreaView edges={['bottom']} style={styles.footer}>
          {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
          {!triggerDraftCanSubmit(draft) ? <Text style={[styles.requiredHint, { color: colors.textMuted }]}>{t('triggers.form.requiredHint')}</Text> : null}
          <Pressable
            accessibilityLabel={submitLabel}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            onPress={() => { void submit(); }}
            style={({ pressed }) => [styles.submit, { backgroundColor: colors.primaryButton }, !canSubmit && styles.disabled, pressed && styles.pressed]}
          >
            {saving ? <ActivityIndicator color="#fff" /> : <><SystemIcon android="bolt" color="#fff" ios="bolt.fill" size={17} /><Text style={styles.submitText}>{submitLabel}</Text></>}
          </Pressable>
        </SafeAreaView>
      </View>
    </View>
  </KeyboardAvoidingView>;
}

function Section({ children, flush, title }: { children: ReactNode; flush?: boolean; title: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.group}>
    <Text style={[styles.heading, { color: colors.textMuted }]}>{title}</Text>
    <View style={[styles.section, flush && styles.sectionFlush, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>
  </View>;
}

function Field({ autoCapitalize, compact, keyboard, label, maxLength, multiline, onChange, placeholder, required, tall, value }: {
  autoCapitalize?: 'none' | 'sentences'; compact?: boolean; keyboard?: 'number-pad'; label: string; maxLength?: number; multiline?: boolean;
  onChange(value: string): void; placeholder?: string; required?: boolean; tall?: boolean; value: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [focused, setFocused] = useState(false);
  return <View style={[styles.field, compact && styles.compactField]}>
    <View style={styles.fieldLabelRow}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <Text style={[styles.fieldRequirement, { color: required ? colors.primary : colors.textMuted }]}>{t(required ? 'triggers.form.required' : 'triggers.form.optional')}</Text>
    </View>
    <TextInput
      accessibilityLabel={label}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCapitalize !== 'none'}
      keyboardType={keyboard}
      maxLength={maxLength}
      multiline={multiline}
      onChangeText={onChange}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      placeholder={placeholder}
      placeholderTextColor={colors.textMuted}
      selectionColor={colors.primary}
      style={[styles.input, multiline && styles.multiline, tall && styles.tall, { backgroundColor: colors.surface, borderColor: focused ? colors.primary : colors.border, color: colors.text }]}
      value={value}
    />
  </View>;
}

function SourceChoice({ active, description, label, last, onPress, type }: { active: boolean; description: string; label: string; last: boolean; onPress(): void; type: TriggerSourceType }) {
  const { colors } = useMobileTheme();
  const icon = type === 'schedule'
    ? { android: 'schedule' as const, ios: 'clock' as const }
    : type === 'file-change'
      ? { android: 'folder' as const, ios: 'folder.badge.gearshape' as const }
      : { android: 'auto_awesome' as const, ios: 'sparkles' as const };
  return <>
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.sourceChoice, pressed && { backgroundColor: colors.surfaceMuted }]}
    >
      <View style={[styles.sourceIcon, { backgroundColor: active ? colors.primarySoft : colors.surfaceMuted }]}><SystemIcon {...icon} color={active ? colors.primary : colors.textMuted} size={19} /></View>
      <View style={styles.sourceCopy}><Text style={[styles.sourceLabel, { color: active ? colors.primary : colors.text }]}>{label}</Text><Text style={[styles.sourceDescription, { color: colors.textMuted }]}>{description}</Text></View>
      <SystemIcon android={active ? 'check_circle' : 'circle'} color={active ? colors.primary : colors.border} ios={active ? 'checkmark.circle.fill' : 'circle'} size={20} />
    </Pressable>
    {!last ? <View style={[styles.sourceDivider, { backgroundColor: colors.border }]} /> : null}
  </>;
}

function SegmentedChoices({ compact, label, onSelect, options, selected }: { compact?: boolean; label?: string; onSelect(value: string): void; options: Choice[]; selected: string }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.field, compact && styles.compactChoices]}>
    {label ? <Text style={[styles.label, { color: colors.text }]}>{label}</Text> : null}
    <View style={[styles.segmented, { backgroundColor: colors.surfaceMuted }]}>
      {options.map((option) => <Pressable
        accessibilityLabel={option.label}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected === option.value }}
        key={option.value}
        onPress={() => onSelect(option.value)}
        style={({ pressed }) => [styles.segment, selected === option.value && { backgroundColor: colors.surface }, pressed && styles.pressed]}
      ><Text numberOfLines={1} style={[styles.segmentText, { color: selected === option.value ? colors.text : colors.textMuted }]}>{option.label}</Text></Pressable>)}
    </View>
  </View>;
}

function ChipSelect({ label, onChange, options, selected }: { label: string; onChange(values: string[]): void; options: Choice[]; selected: string[] }) {
  const { colors } = useMobileTheme();
  const selectedSet = new Set(selected);
  return <View style={styles.field}>
    <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
    <View style={styles.chips}>{options.map((option) => {
      const active = selectedSet.has(option.value);
      return <Pressable
        accessibilityLabel={option.label}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: active }}
        key={option.value}
        onPress={() => onChange(active ? selected.filter((item) => item !== option.value) : [...selected, option.value])}
        style={({ pressed }) => [styles.chip, { backgroundColor: active ? colors.primarySoft : colors.surface, borderColor: active ? colors.primary : colors.border }, pressed && styles.pressed]}
      ><Text style={[styles.chipText, { color: active ? colors.primary : colors.text }]}>{option.label}</Text></Pressable>;
    })}</View>
  </View>;
}

function sourceOptions(t: Translate): { description: string; label: string; value: TriggerSourceType }[] {
  return [
    { value: 'schedule', label: t('triggers.form.source.schedule'), description: t('triggers.form.source.scheduleDescription') },
    { value: 'file-change', label: t('triggers.form.source.fileChange'), description: t('triggers.form.source.fileChangeDescription') },
    { value: 'ai-session', label: t('triggers.form.source.aiSession'), description: t('triggers.form.source.aiSessionDescription') },
  ];
}

function sourceSectionTitle(type: TriggerSourceType, t: Translate) {
  return sourceOptions(t).find((option) => option.value === type)?.label || t('triggers.form.source');
}

function scheduleOptions(t: Translate): Choice[] { return [{ value: 'interval', label: t('triggers.form.schedule.interval') }, { value: 'daily', label: t('triggers.form.schedule.daily') }, { value: 'weekly', label: t('triggers.form.schedule.weekly') }]; }
function intervalUnitOptions(t: Translate): Choice[] { return [{ value: 'minute', label: t('triggers.form.unit.minute') }, { value: 'hour', label: t('triggers.form.unit.hour') }, { value: 'day', label: t('triggers.form.unit.day') }, { value: 'week', label: t('triggers.form.unit.week') }]; }
function busyOptions(t: Translate): Choice[] { return [{ value: 'skip', label: t('triggers.form.busy.skip') }, { value: 'queue', label: t('triggers.form.busy.queue') }]; }
function weekdayOptions(t: Translate): Choice[] { return [['1', 'monday'], ['2', 'tuesday'], ['3', 'wednesday'], ['4', 'thursday'], ['5', 'friday'], ['6', 'saturday'], ['0', 'sunday']].map(([value, day]) => ({ value, label: t(`triggers.form.weekday.${day}` as Parameters<Translate>[0]) })); }
function statusOptions(t: Translate): Choice[] { return ['running', 'waiting', 'idle', 'failed'].map((value) => ({ value, label: t(`triggers.form.status.${value}` as Parameters<Translate>[0]) })); }
function phaseOptions(t: Translate): Choice[] { return ['thinking', 'tool', 'editing', 'approval', 'responding', 'unknown'].map((value) => ({ value, label: t(`triggers.form.phase.${value}` as Parameters<Translate>[0]) })); }

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { alignSelf: 'center', gap: 18, maxWidth: 640, paddingBottom: 176, width: '100%' },
  intro: { alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 20, paddingHorizontal: 20 },
  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.6, lineHeight: 34, textAlign: 'center' },
  introText: { fontSize: 15, lineHeight: 22, maxWidth: 440, textAlign: 'center' },
  group: { gap: 8 },
  heading: { fontSize: 13, fontWeight: '600', lineHeight: 18, paddingHorizontal: 4 },
  section: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, gap: 16, overflow: 'hidden', padding: 14 },
  sectionFlush: { padding: 0 },
  field: { gap: 7 }, compactField: { flex: 1 }, compactChoices: { flex: 2 },
  fieldLabelRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  label: { fontSize: 14, fontWeight: '600', lineHeight: 19 },
  fieldRequirement: { fontSize: 12, fontWeight: '500', lineHeight: 16 },
  input: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, lineHeight: 22, minHeight: 52, paddingHorizontal: 13, paddingVertical: 12 },
  multiline: { minHeight: 82, textAlignVertical: 'top' }, tall: { minHeight: 144 },
  sourceChoices: { overflow: 'hidden' },
  sourceChoice: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 76, paddingHorizontal: 14 },
  sourceDivider: { height: StyleSheet.hairlineWidth, marginLeft: 64 },
  sourceIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  sourceCopy: { flex: 1, gap: 2 }, sourceLabel: { fontSize: 15, fontWeight: '600', lineHeight: 21 }, sourceDescription: { fontSize: 12, lineHeight: 17 },
  intervalRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 10 },
  segmented: { borderRadius: 10, flexDirection: 'row', padding: 3 },
  segment: { alignItems: 'center', borderRadius: 8, flex: 1, justifyContent: 'center', minHeight: 36, paddingHorizontal: 7 },
  segmentText: { fontSize: 12, fontWeight: '600', lineHeight: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center', minHeight: 38, paddingHorizontal: 12, paddingVertical: 8 },
  chipText: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  advancedCard: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  advancedHeader: { alignItems: 'center', flexDirection: 'row', gap: 12, minHeight: 72, paddingHorizontal: 14 },
  advancedIcon: { alignItems: 'center', borderRadius: 10, height: 38, justifyContent: 'center', width: 38 },
  advancedCopy: { flex: 1, gap: 2 }, advancedTitle: { fontSize: 15, fontWeight: '700', lineHeight: 20 }, advancedDescription: { fontSize: 12, lineHeight: 17 },
  advancedFields: { borderTopWidth: StyleSheet.hairlineWidth, gap: 16, padding: 14 },
  footerLayer: { bottom: 0, left: 0, paddingTop: 34, position: 'absolute', right: 0 },
  footer: { gap: 8, paddingHorizontal: 16 },
  requiredHint: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
  error: { borderRadius: 12, fontSize: 13, lineHeight: 19, padding: 12 },
  submit: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700', lineHeight: 22 },
  disabled: { opacity: 0.4 }, pressed: { opacity: 0.72 },
});
