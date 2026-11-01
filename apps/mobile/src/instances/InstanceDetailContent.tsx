import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { InstanceDetailContentProps } from './instance-detail-content-types';
import { PRIMARY_INSTANCE_LIFECYCLE_ACTIONS, instanceLifecycleActionLabel, instanceRetryAction } from './instance-lifecycle';
import { InstanceOverview } from './InstanceNativeSections';

export function InstanceDetailContent(props: InstanceDetailContentProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const retryAction = instanceRetryAction(props.actions);
  const lifecycleColor = props.statusTone === 'healthy' ? '#34c759' : props.statusTone === 'error' ? colors.error : colors.textMuted;

  return <Screen>
    <View style={[styles.statusSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {props.lifecycleAction ? <ActivityIndicator color={colors.primary} size="small" /> : <View style={[styles.statusDot, { backgroundColor: lifecycleColor }]} />}
      <Text style={[styles.statusText, { color: colors.textMuted }]}>{props.status}</Text>
    </View>

    <View accessibilityRole="toolbar" style={[styles.lifecycleToolbar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {PRIMARY_INSTANCE_LIFECYCLE_ACTIONS.map((action) => {
        const enabled = props.actionsEnabled && !props.lifecycleAction && props.actions.includes(action);
        const destructive = action === 'stop';
        return <Pressable
          accessibilityLabel={instanceLifecycleActionLabel(action, t)}
          accessibilityRole="button"
          accessibilityState={{ disabled: !enabled, busy: props.lifecycleAction === action }}
          disabled={!enabled}
          key={action}
          onPress={() => props.onLifecycleAction(action)}
          style={({ pressed }) => [styles.lifecycleButton, !enabled && styles.lifecycleButtonDisabled, pressed && styles.pressed]}
        >
          {props.lifecycleAction === action
            ? <ActivityIndicator color={colors.primary} size="small" />
            : <Icon
              color={enabled ? destructive ? colors.error : colors.primary : colors.textMuted}
              name={action === 'start' ? 'play-circle' : action === 'stop' ? 'stop-circle' : 'refresh'}
              size={22}
            />}
          <Text style={[styles.lifecycleButtonText, { color: enabled ? destructive ? colors.error : colors.primary : colors.textMuted }]}>{instanceLifecycleActionLabel(action, t)}</Text>
        </Pressable>;
      })}
      {retryAction ? <Pressable
        accessibilityLabel={instanceLifecycleActionLabel(retryAction, t)}
        accessibilityRole="button"
        accessibilityState={{ disabled: !props.actionsEnabled || Boolean(props.lifecycleAction), busy: props.lifecycleAction === retryAction }}
        disabled={!props.actionsEnabled || Boolean(props.lifecycleAction)}
        onPress={() => props.onLifecycleAction(retryAction)}
        style={({ pressed }) => [styles.lifecycleButton, (!props.actionsEnabled || props.lifecycleAction) && styles.lifecycleButtonDisabled, pressed && styles.pressed]}
      >
        {props.lifecycleAction === retryAction ? <ActivityIndicator color={colors.primary} size="small" /> : <Icon color={colors.primary} name="refresh" size={22} />}
        <Text style={[styles.lifecycleButtonText, { color: colors.primary }]}>{instanceLifecycleActionLabel(retryAction, t)}</Text>
      </Pressable> : null}
    </View>

    <InstanceOverview
      activeSessionCount={props.activeSessionCount}
      heartbeat={props.heartbeat}
      nodeName={props.nodeName}
      onCreateSession={props.onCreateSession}
      onShowHistory={props.onShowHistory}
      onShowSessions={props.onShowSessions}
      onShowWorktrees={props.onShowWorktrees}
      problemSessionCount={props.problemSessionCount}
      protocol={props.protocol}
      protocolCompatible={props.protocolCompatible}
      runtime={props.runtime}
      workspace={props.workspace}
    />

    {props.protocolWarning ? <Notice text={props.protocolWarning} /> : null}
    {props.error ? <Notice error text={`${props.error.code}: ${props.error.message}`} /> : null}
  </Screen>;
}

function Notice({ error, text }: { error?: boolean; text: string }) {
  const { colors } = useMobileTheme();
  return <View style={[styles.notice, { backgroundColor: error ? colors.errorSoft : colors.notice }]}>
    <Icon color={error ? colors.error : colors.noticeText} name={error ? 'alert-circle' : 'warning'} size={17} />
    <Text style={[styles.noticeText, { color: error ? colors.error : colors.noticeText }]}>{text}</Text>
  </View>;
}

const styles = StyleSheet.create({
  statusSummary: { alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 8, minHeight: 42, paddingHorizontal: 12 },
  statusDot: { borderRadius: 999, height: 8, width: 8 },
  statusText: { fontSize: 13, textTransform: 'capitalize' },
  lifecycleToolbar: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 62, overflow: 'hidden' },
  lifecycleButton: { alignItems: 'center', flex: 1, gap: 4, justifyContent: 'center', minHeight: 62, minWidth: 0, paddingHorizontal: 4, paddingVertical: 8 },
  lifecycleButtonDisabled: { opacity: 0.42 },
  lifecycleButtonText: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  notice: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 9, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.65 },
});
