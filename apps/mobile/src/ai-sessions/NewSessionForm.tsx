import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Screen } from '../components/Screen';
import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import type { NewSessionFormProps } from './new-session-types';

export function NewSessionForm(props: NewSessionFormProps) {
  const { colors } = useMobileTheme();
  return <Screen>
    <Text style={[styles.heading, { color: colors.text }]}>Start a new session</Text>
    <Text style={[styles.description, { color: colors.textMuted }]}>Choose where the work should run, then describe what you want the agent to do.</Text>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
      <Choice label="Instance" value={props.selectedInstance?.name || 'Choose an instance'} onPress={() => choose('Instance', props.instances.map((instance) => ({ label: instance.name, value: instance.id })), props.onInstanceChange)} />
      <Choice label="Agent" value={props.selectedInstance?.availableAgents.find((agent) => agent.id === props.selectedAgent)?.name || 'Choose an agent'} onPress={() => choose('Agent', (props.selectedInstance?.availableAgents ?? []).map((agent) => ({ label: agent.name, value: agent.id })), props.onAgentChange)} />
      <Choice label="Permission" value={props.permissionMode === 'ask' ? 'Ask before changes' : props.permissionMode === 'auto-review' ? 'Auto review' : 'Full access'} onPress={() => choose('Permission', [{ label: 'Ask before changes', value: 'ask' }, { label: 'Auto review', value: 'auto-review' }, { label: 'Full access', value: 'full-access' }], (value) => props.onPermissionModeChange(value as NewSessionFormProps['permissionMode']))} />
      <TextInput accessibilityLabel="Working directory" autoCapitalize="none" autoCorrect={false} onChangeText={props.onCwdChange} placeholder="Working directory" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surfaceMuted, color: colors.text }]} value={props.cwd} />
    </View>
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
      <Text style={[styles.label, { color: colors.textMuted }]}>PROMPT</Text>
      <TextInput accessibilityLabel="Prompt" multiline onChangeText={props.onMessageChange} placeholder="Describe what you want to do" placeholderTextColor={colors.textMuted} style={[styles.prompt, { backgroundColor: colors.surfaceMuted, color: colors.text }]} value={props.message} />
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: props.disabled }} disabled={props.disabled} onPress={props.onCreate} style={({ pressed }) => [styles.button, { backgroundColor: colors.primaryButton }, props.disabled && styles.disabled, pressed && styles.pressed]}>
        <SystemIcon android="arrow_upward" color="#fff" ios="arrow.up" size={17} /><Text style={styles.buttonText}>{props.busy ? 'Creating…' : 'Create Session'}</Text>
      </Pressable>
    </View>
    {props.error ? <Text accessibilityLiveRegion="polite" style={[styles.error, { backgroundColor: colors.errorSoft, color: colors.error }]}>{props.error}</Text> : null}
  </Screen>;
}

function Choice({ label, value, onPress }: { label: string; value: string; onPress(): void }) {
  const { colors } = useMobileTheme();
  return <Pressable accessibilityRole="button" onPress={onPress} style={styles.choice}><Text style={[styles.choiceLabel, { color: colors.text }]}>{label}</Text><Text numberOfLines={1} style={[styles.choiceValue, { color: colors.textMuted }]}>{value}</Text><SystemIcon android="expand_more" color={colors.textMuted} ios="chevron.down" size={12} /></Pressable>;
}

function choose(title: string, options: { label: string; value: string }[], onSelect: (value: string) => void) {
  Alert.alert(title, undefined, [...options.map((option) => ({ text: option.label, onPress: () => onSelect(option.value) })), { text: 'Cancel', style: 'cancel' }]);
}

const styles = StyleSheet.create({
  heading: { fontSize: 28, fontWeight: '700', letterSpacing: -0.6 }, description: { fontSize: 14, lineHeight: 20, marginBottom: 4 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, gap: 10, padding: 14 }, choice: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 44 }, choiceLabel: { fontSize: 15, fontWeight: '600', width: 92 }, choiceValue: { flex: 1, fontSize: 14, textAlign: 'right' },
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4 }, input: { borderRadius: 11, fontFamily: 'monospace', fontSize: 14, minHeight: 46, paddingHorizontal: 12 }, prompt: { borderRadius: 12, fontSize: 15, lineHeight: 21, minHeight: 150, padding: 12, textAlignVertical: 'top' },
  button: { alignItems: 'center', borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 48 }, buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' }, disabled: { opacity: 0.4 }, pressed: { opacity: 0.72 }, error: { borderRadius: 12, fontSize: 13, lineHeight: 19, padding: 12 },
});
