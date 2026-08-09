import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ControlPlaneTriggerTemplateInput } from '@task-handoff/protocol/triggers';

import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { emptyTriggerDraft, triggerInput, type TriggerFormDraft, type TriggerScheduleKind, type TriggerSourceType } from './model';

export function TriggerForm({ initial = emptyTriggerDraft(), submitLabel, onSubmit }: { initial?: TriggerFormDraft; submitLabel: string; onSubmit(input: ControlPlaneTriggerTemplateInput): Promise<void> }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof TriggerFormDraft>(key: K, value: TriggerFormDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    setSaving(true); setError('');
    try { await onSubmit(triggerInput(draft)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); }
  };
  return <Screen contentContainerStyle={styles.screen}>
    <Section title={t('triggers.form.basic')}>
      <Field label={t('triggers.form.name')} value={draft.name} onChange={(value) => set('name', value)} />
      <Field label={t('triggers.form.description')} value={draft.description} onChange={(value) => set('description', value)} multiline />
      <ChoiceRow values={['schedule', 'file-change', 'ai-session']} selected={draft.sourceType} label={t('triggers.form.type')} onSelect={(value) => set('sourceType', value as TriggerSourceType)} />
    </Section>
    <Section title={t('triggers.form.source')}>
      {draft.sourceType === 'schedule' ? <>
        <ChoiceRow values={['interval', 'daily', 'weekly']} selected={draft.scheduleKind} label={t('triggers.form.scheduleMode')} onSelect={(value) => set('scheduleKind', value as TriggerScheduleKind)} />
        {draft.scheduleKind === 'interval' ? <View style={styles.inline}><Field compact keyboard="numeric" label={t('triggers.form.interval')} value={draft.intervalValue} onChange={(value) => set('intervalValue', value)} /><ChoiceRow compact values={['minute', 'hour', 'day', 'week']} selected={draft.intervalUnit} onSelect={(value) => set('intervalUnit', value as TriggerFormDraft['intervalUnit'])} /></View> : <>
          <Field label={t('triggers.form.time')} value={draft.timeOfDay} onChange={(value) => set('timeOfDay', value)} />
          <Field label={t('triggers.form.timezone')} value={draft.timezone} onChange={(value) => set('timezone', value)} />
          {draft.scheduleKind === 'weekly' ? <ChipSelect label={t('triggers.form.weekdays')} options={[['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']]} selected={draft.weekdays.map(String)} onChange={(values) => set('weekdays', values.map(Number))} /> : null}
        </>}
      </> : draft.sourceType === 'file-change' ? <>
        <Field label={t('triggers.form.roots')} value={draft.roots} onChange={(value) => set('roots', value)} />
        <Field label={t('triggers.form.globs')} value={draft.globs} onChange={(value) => set('globs', value)} />
        <Field label={t('triggers.form.ignore')} value={draft.ignore} onChange={(value) => set('ignore', value)} />
        <Field keyboard="numeric" label={t('triggers.form.debounce')} value={draft.debounceMs} onChange={(value) => set('debounceMs', value)} />
      </> : <>
        <Field label={t('triggers.form.agent')} value={draft.agent} onChange={(value) => set('agent', value)} />
        <ChipSelect label={t('triggers.form.statuses')} options={['running', 'waiting', 'idle', 'failed'].map((value) => [value, value])} selected={draft.statuses} onChange={(values) => set('statuses', values as TriggerFormDraft['statuses'])} />
        <ChipSelect label={t('triggers.form.phases')} options={['thinking', 'tool', 'editing', 'approval', 'responding', 'unknown'].map((value) => [value, value])} selected={draft.phases} onChange={(values) => set('phases', values as TriggerFormDraft['phases'])} />
      </>}
    </Section>
    <Section title={t('triggers.form.policy')}>
      <Field keyboard="numeric" label={t('triggers.form.cooldown')} value={draft.cooldownMs} onChange={(value) => set('cooldownMs', value)} />
      <ChoiceRow values={['skip', 'queue']} selected={draft.whenBusy} label={t('triggers.form.whenBusy')} onSelect={(value) => set('whenBusy', value as TriggerFormDraft['whenBusy'])} />
      <Field keyboard="numeric" label={t('triggers.form.concurrency')} value={draft.maxConcurrentRuns} onChange={(value) => set('maxConcurrentRuns', value)} />
    </Section>
    <Section title={t('triggers.form.action')}><Field label={t('triggers.form.prompt')} value={draft.promptTemplate} onChange={(value) => set('promptTemplate', value)} multiline tall /></Section>
    {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={saving} onPress={() => { void submit(); }} style={({ pressed }) => [styles.submit, { backgroundColor: colors.primaryButton }, (pressed || saving) && styles.pressed]}>
      {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{submitLabel}</Text>}
    </Pressable>
  </Screen>;
}

function Section({ children, title }: { children: React.ReactNode; title: string }) { const { colors } = useMobileTheme(); return <View style={styles.group}><Text style={[styles.heading, { color: colors.textMuted }]}>{title}</Text><View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View></View>; }
function Field({ compact, keyboard, label, multiline, onChange, tall, value }: { compact?: boolean; keyboard?: 'numeric'; label: string; multiline?: boolean; onChange(value: string): void; tall?: boolean; value: string }) { const { colors } = useMobileTheme(); return <View style={[styles.field, compact && styles.compactField]}><Text style={[styles.label, { color: colors.text }]}>{label}</Text><TextInput keyboardType={keyboard} multiline={multiline} onChangeText={onChange} placeholderTextColor={colors.textMuted} style={[styles.input, multiline && styles.multiline, tall && styles.tall, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]} value={value} /></View>; }
function ChoiceRow({ compact, label, onSelect, selected, values }: { compact?: boolean; label?: string; onSelect(value: string): void; selected: string; values: string[] }) { const { colors } = useMobileTheme(); return <View style={[styles.field, compact && styles.compactChoice]}>{label ? <Text style={[styles.label, { color: colors.text }]}>{label}</Text> : null}<View style={styles.choices}>{values.map((value) => <Pressable key={value} onPress={() => onSelect(value)} style={[styles.choice, { backgroundColor: selected === value ? colors.primarySoft : colors.background, borderColor: selected === value ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: selected === value ? colors.primary : colors.text }]}>{value}</Text></Pressable>)}</View></View>; }
function ChipSelect({ label, onChange, options, selected }: { label: string; onChange(values: string[]): void; options: string[][]; selected: string[] }) { const { colors } = useMobileTheme(); const selectedSet = new Set(selected); return <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{label}</Text><View style={styles.choices}>{options.map(([value, text]) => <ToggleChip key={value} active={selectedSet.has(value)} label={text} onPress={() => onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value])} />)}</View></View>; }
function ToggleChip({ active, label, onPress }: { active: boolean; label: string; onPress(): void }) { const { colors } = useMobileTheme(); return <Pressable onPress={onPress} style={[styles.choice, { backgroundColor: active ? colors.primarySoft : colors.background, borderColor: active ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: active ? colors.primary : colors.text }]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  screen: { paddingBottom: 40 }, group: { gap: 7 }, heading: { fontSize: 13, fontWeight: '600', paddingHorizontal: 4, textTransform: 'uppercase' }, section: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 14, padding: 14 }, field: { gap: 7 }, compactField: { flex: 1 }, compactChoice: { flex: 2 }, label: { fontSize: 14, fontWeight: '600' }, input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, fontSize: 16, minHeight: 42, paddingHorizontal: 11, paddingVertical: 9 }, multiline: { minHeight: 70, textAlignVertical: 'top' }, tall: { minHeight: 130 }, inline: { alignItems: 'flex-end', flexDirection: 'row', gap: 10 }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, choice: { borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, minHeight: 36, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 7 }, choiceText: { fontSize: 13, fontWeight: '600' }, error: { fontSize: 13, lineHeight: 18 }, submit: { alignItems: 'center', borderRadius: 12, justifyContent: 'center', minHeight: 48 }, submitText: { color: '#fff', fontSize: 16, fontWeight: '700' }, pressed: { opacity: 0.65 },
});
