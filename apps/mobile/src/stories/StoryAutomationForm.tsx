import { useEffect, useMemo, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { Story, StoryAction, StoryAutomationStatus } from '@task-handoff/protocol/stories';

import { NewSessionContextMenu } from '../ai-sessions/NewSessionContextMenu';
import { ContextPill } from '../components/ContextPill';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n, type Translate } from '../i18n';
import {
  storyAutomationCreateInput,
  storyAutomationDraft,
  storyAutomationDraftValid,
  storyAutomationDraftWithActionValid,
  storyAutomationUpdateInput,
  storyAutomationWithActionInput,
  type StoryAutomationDraft,
} from './story-automation-model';

export function StoryAutomationForm({ automationId, nodeId, onSaved, storyId }: {
  automationId?: string;
  nodeId?: string;
  onSaved(): void;
  storyId?: string;
}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const runtime = useMobileControlPlaneRuntime();
  const { state: directory } = useActiveDirectories();
  const [story, setStory] = useState<Story>();
  const [status, setStatus] = useState<StoryAutomationStatus>();
  const [draft, setDraft] = useState<StoryAutomationDraft>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [actionMode, setActionMode] = useState<'existing' | 'new'>('existing');
  const [newActionTitle, setNewActionTitle] = useState('');
  const [newActionPrompt, setNewActionPrompt] = useState('');
  const [newActionTargetId, setNewActionTargetId] = useState('');
  useEffect(() => {
    if (!runtime.api || !storyId || !nodeId) return;
    let live = true;
    void Promise.all([
      runtime.api.stories.get(storyId, nodeId),
      automationId ? runtime.api.stories.getAutomation(storyId, automationId, nodeId) : Promise.resolve(undefined),
    ]).then(([storyValue, statusValue]) => {
      if (!live) return;
      setStory(storyValue);
      setStatus(statusValue);
      setDraft(storyAutomationDraft(storyValue, statusValue));
      setNewActionTargetId((current) => current || directoryInstances(storyValue, directory.instances)[0]?.id || '');
    }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [automationId, directory.instances, nodeId, runtime.api, storyId]);
  const instances = useMemo(() => story ? directoryInstances(story, directory.instances) : [], [directory.instances, story]);
  const actions = useMemo(() => (story?.actions || []).filter((action) => Boolean(action.targetInstanceId)), [story]);
  const selectedAction = actions.find((action) => action.id === draft?.actionId);
  const selectedNewActionTarget = instances.find((instance) => instance.id === newActionTargetId);
  const set = <K extends keyof StoryAutomationDraft>(key: K, value: StoryAutomationDraft[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const newActionDraft: StoryAction = { id: 'draft-action', title: newActionTitle.trim(), promptTemplate: newActionPrompt.trim(), targetInstanceId: newActionTargetId };
  const newActionValid = Boolean(newActionDraft.title && newActionDraft.promptTemplate && newActionDraft.targetInstanceId);
  const valid = Boolean(story && draft && (actionMode === 'new'
    ? newActionValid && storyAutomationDraftWithActionValid(draft, story, newActionDraft)
    : storyAutomationDraftValid(draft, story)));
  const save = async () => {
    if (!runtime.api || !story || !draft || !valid || saving) return;
    setSaving(true);
    setError('');
    try {
      if (actionMode === 'new' && !automationId) {
        const action: StoryAction = { id: `action-${Crypto.randomUUID()}`, title: newActionTitle.trim(), promptTemplate: newActionPrompt.trim(), targetInstanceId: newActionTargetId };
        await runtime.api.stories.createAutomationWithAction(story.id, story.ownerNodeId, storyAutomationWithActionInput(draft, action));
      } else if (automationId) await runtime.api.stories.updateAutomation(story.id, automationId, story.ownerNodeId, storyAutomationUpdateInput(draft));
      else await runtime.api.stories.createAutomation(story.id, story.ownerNodeId, storyAutomationCreateInput(draft, story.id));
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  if (loading) return <ActivityIndicator accessibilityLabel={t('common.loading')} style={styles.loading} />;
  if (!story || !draft || (automationId && !status)) return <View style={styles.state}><Text style={{ color: colors.error }}>{error || t('stories.automationNotFound')}</Text></View>;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
    <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <FormSection title={t('stories.automationAction')}>
        {!automationId ? <SegmentedChoices onSelect={(value) => setActionMode(value as 'existing' | 'new')} options={[{ value: 'existing', label: t('stories.selectAction') }, { value: 'new', label: t('stories.newAction') }]} selected={actionMode} /> : null}
        {actionMode === 'new' && !automationId ? <>
          <Field label={t('stories.actionTitle')} onChange={setNewActionTitle} value={newActionTitle} />
          <Field label={t('stories.actionPrompt')} multiline onChange={setNewActionPrompt} value={newActionPrompt} />
          <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{t('stories.actionTarget')}</Text><NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={saving || !instances.length} onSelect={setNewActionTargetId} options={instances.map((instance) => ({ value: instance.id, label: instance.name, description: instance.id, systemImage: 'server.rack' }))} selectedValue={newActionTargetId} title={t('stories.actionTarget')}>{(onPress) => <ContextPill disabled={saving || !instances.length} icon={{ android: 'dns', ios: 'server.rack' }} label={selectedNewActionTarget?.name || t('stories.noAvailableInstance')} onPress={onPress} />}</NewSessionContextMenu></View>
        </> : <NewSessionContextMenu cancelLabel={t('common.cancel')} disabled={Boolean(automationId) || saving || !actions.length} onSelect={(value) => set('actionId', value)} options={actions.map((action) => ({ value: action.id, label: action.title, description: action.promptTemplate, systemImage: 'play.fill' }))} selectedValue={draft.actionId} title={t('stories.automationAction')}>
          {(onPress) => <ContextPill disabled={Boolean(automationId) || saving || !actions.length} icon={{ android: 'bolt', ios: 'bolt' }} label={selectedAction?.title || t('stories.selectAction')} onPress={onPress} />}
        </NewSessionContextMenu>}
      </FormSection>

      <FormSection title={t('stories.automationSchedule')}>
        <SegmentedChoices onSelect={(value) => set('scheduleKind', value as StoryAutomationDraft['scheduleKind'])} options={scheduleOptions(t)} selected={draft.scheduleKind} />
        {draft.scheduleKind === 'interval' ? <Field keyboard="number-pad" label={t('triggers.form.interval')} onChange={(value) => set('intervalMinutes', value)} suffix={t('triggers.form.unit.minute')} value={draft.intervalMinutes} /> : <>
          <Field label={t('triggers.form.time')} onChange={(value) => set('timeOfDay', value)} placeholder="09:00" value={draft.timeOfDay} />
          <Field label={t('triggers.form.timezone')} onChange={(value) => set('timezone', value)} placeholder="Asia/Shanghai" value={draft.timezone} />
          {draft.scheduleKind === 'weekly' ? <WeekdayChoices onChange={(weekdays) => set('weekdays', weekdays)} selected={draft.weekdays} /> : null}
        </>}
      </FormSection>

      <FormSection title={t('triggers.form.policy')}>
        <SegmentedChoices label={t('triggers.form.whenBusy')} onSelect={(value) => set('whenBusy', value as StoryAutomationDraft['whenBusy'])} options={busyOptions(t)} selected={draft.whenBusy} />
        <Field keyboard="number-pad" label={t('triggers.form.concurrency')} onChange={(value) => set('maxConcurrentRuns', value)} value={draft.maxConcurrentRuns} />
        <Field keyboard="number-pad" label={t('stories.cooldownMinutes')} onChange={(value) => set('cooldownMinutes', value)} suffix={t('triggers.form.unit.minute')} value={draft.cooldownMinutes} />
        <View style={styles.switchRow}><Text style={[styles.label, { color: colors.text }]}>{t('stories.automationEnabled')}</Text><Switch onValueChange={(value) => set('enabled', value)} trackColor={{ false: colors.border, true: colors.primary }} value={draft.enabled} /></View>
      </FormSection>

      {error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{error}</Text> : null}
      {!valid ? <Text style={[styles.hint, { color: colors.textMuted }]}>{t('stories.automationRequiredHint')}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !valid || saving }} disabled={!valid || saving} onPress={() => { void save(); }} style={({ pressed }) => [styles.submit, { backgroundColor: colors.primaryButton }, (!valid || saving) && styles.disabled, pressed && styles.pressed]}>{saving ? <ActivityIndicator color="#fff" /> : <><SystemIcon android="schedule" color="#fff" ios="calendar.badge.clock" size={18} /><Text style={styles.submitText}>{t(automationId ? 'common.save' : 'stories.addAutomation')}</Text></>}</Pressable>
    </ScrollView>
  </KeyboardAvoidingView>;
}

function FormSection({ children, title }: { children: React.ReactNode; title: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.group}><Text style={[styles.heading, { color: colors.textMuted }]}>{title}</Text><View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View></View>;
}

function Field({ keyboard, label, multiline, onChange, placeholder, suffix, value }: { keyboard?: 'number-pad'; label: string; multiline?: boolean; onChange(value: string): void; placeholder?: string; suffix?: string; value: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{label}</Text><View style={styles.inputRow}><TextInput accessibilityLabel={label} autoCapitalize="none" keyboardType={keyboard} multiline={multiline} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.textMuted} style={[styles.input, multiline && styles.textarea, { backgroundColor: colors.surfaceMuted, borderColor: colors.border, color: colors.text }]} value={value} />{suffix ? <Text style={[styles.suffix, { color: colors.textMuted }]}>{suffix}</Text> : null}</View></View>;
}

function directoryInstances(story: Story, instances: readonly { id: string; name: string; nodeId: string; ready: boolean }[]) {
  return instances.filter((instance) => instance.nodeId === story.ownerNodeId && instance.ready);
}

function SegmentedChoices({ label, onSelect, options, selected }: { label?: string; onSelect(value: string): void; options: { label: string; value: string }[]; selected: string }) {
  const { colors } = useMobileTheme();
  return <View style={styles.field}>{label ? <Text style={[styles.label, { color: colors.text }]}>{label}</Text> : null}<View style={[styles.segmented, { backgroundColor: colors.surfaceMuted }]}>{options.map((option) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected === option.value }} key={option.value} onPress={() => onSelect(option.value)} style={[styles.segment, selected === option.value && { backgroundColor: colors.surface }]}><Text style={[styles.segmentText, { color: selected === option.value ? colors.text : colors.textMuted }]}>{option.label}</Text></Pressable>)}</View></View>;
}

function WeekdayChoices({ onChange, selected }: { onChange(value: number[]): void; selected: number[] }) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  return <View style={styles.field}><Text style={[styles.label, { color: colors.text }]}>{t('triggers.form.weekdays')}</Text><View style={styles.chips}>{weekdayOptions(t).map((option) => { const value = Number(option.value); const active = selected.includes(value); return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: active }} key={value} onPress={() => onChange(active ? selected.filter((day) => day !== value) : [...selected, value])} style={[styles.chip, { backgroundColor: active ? colors.primarySoft : colors.surfaceMuted, borderColor: active ? colors.primary : colors.border }]}><Text style={[styles.chipText, { color: active ? colors.primary : colors.text }]}>{option.label}</Text></Pressable>; })}</View></View>;
}

function scheduleOptions(t: Translate) { return [{ value: 'interval', label: t('triggers.form.schedule.interval') }, { value: 'daily', label: t('triggers.form.schedule.daily') }, { value: 'weekly', label: t('triggers.form.schedule.weekly') }]; }
function busyOptions(t: Translate) { return [{ value: 'skip', label: t('triggers.form.busy.skip') }, { value: 'queue', label: t('triggers.form.busy.queue') }]; }
function weekdayOptions(t: Translate) { return [['1', 'monday'], ['2', 'tuesday'], ['3', 'wednesday'], ['4', 'thursday'], ['5', 'friday'], ['6', 'saturday'], ['0', 'sunday']].map(([value, day]) => ({ value, label: t(`triggers.form.weekday.${day}` as Parameters<Translate>[0]) })); }

const styles = StyleSheet.create({
  fill: { flex: 1 }, loading: { flex: 1 }, state: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
  content: { alignSelf: 'center', gap: 18, maxWidth: 640, padding: 16, paddingBottom: 44, width: '100%' },
  group: { gap: 8 }, heading: { fontSize: 13, fontWeight: '600', paddingHorizontal: 4 }, section: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, gap: 16, padding: 14 },
  field: { gap: 7 }, label: { fontSize: 14, fontWeight: '600' }, inputRow: { alignItems: 'center', flexDirection: 'row', gap: 8 }, input: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, flex: 1, fontSize: 15, minHeight: 46, paddingHorizontal: 12 }, textarea: { minHeight: 120, paddingVertical: 12, textAlignVertical: 'top' }, suffix: { fontSize: 13 },
  segmented: { borderRadius: 10, flexDirection: 'row', padding: 3 }, segment: { alignItems: 'center', borderRadius: 8, flex: 1, justifyContent: 'center', minHeight: 38, paddingHorizontal: 6 }, segmentText: { fontSize: 12, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, chip: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, minHeight: 38, paddingHorizontal: 12, paddingVertical: 9 }, chipText: { fontSize: 13, fontWeight: '600' },
  switchRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 44 },
  secondaryAction: { alignItems: 'center', borderRadius: 10, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44 }, secondaryActionText: { fontSize: 14, fontWeight: '600' },
  error: { borderRadius: 10, fontSize: 13, lineHeight: 18, padding: 11 }, hint: { fontSize: 12, textAlign: 'center' },
  submit: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 50 }, submitText: { color: '#fff', fontSize: 15, fontWeight: '600' }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.7 },
});
