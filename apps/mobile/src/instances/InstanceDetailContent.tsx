import { Fragment } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { Screen } from '../components/Screen';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { InstanceDetailContentProps } from './instance-detail-content-types';
import { instanceControlActions, instanceLifecycleActionLabel } from './instance-lifecycle';
import { InstanceOverview } from './InstanceNativeSections';

export function InstanceDetailContent(props: InstanceDetailContentProps) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const lifecycleActions = instanceControlActions(props.actions);
  const lifecycleColor = props.statusTone === 'healthy' ? '#34c759' : props.statusTone === 'error' ? colors.error : colors.textMuted;

  return <Screen>
    <View style={[styles.statusSummary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {props.lifecycleAction ? <ActivityIndicator color={colors.primary} size="small" /> : <View style={[styles.statusDot, { backgroundColor: lifecycleColor }]} />}
      <Text style={[styles.statusText, { color: colors.textMuted }]}>{props.status}</Text>
    </View>

    {lifecycleActions.length ? <View accessibilityRole="toolbar" style={[styles.lifecycleToolbar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {lifecycleActions.map((action, index) => {
        const enabled = !props.lifecycleAction && props.actions.includes(action);
        const destructive = action === 'stop';
        const color = enabled ? destructive ? colors.error : colors.primary : colors.textMuted;
        return <Fragment key={action}>
          {index ? <View style={[styles.lifecycleSeparator, { backgroundColor: colors.border }]} /> : null}
          <Pressable
            accessibilityLabel={instanceLifecycleActionLabel(action, t)}
            accessibilityRole="button"
            accessibilityState={{ disabled: !enabled, busy: props.lifecycleAction === action }}
            disabled={!enabled}
            onPress={() => props.onLifecycleAction(action)}
            style={({ pressed }) => [styles.lifecycleButton, !enabled && styles.lifecycleButtonDisabled, pressed && styles.pressed]}
          >
            {props.lifecycleAction === action
              ? <ActivityIndicator color={colors.primary} size="small" />
              : <Icon
                color={color}
                name={action === 'start' ? 'play-circle' : action === 'stop' ? 'stop-circle' : 'refresh'}
                size={18}
              />}
            <Text numberOfLines={1} style={[styles.lifecycleButtonText, { color }]}>{instanceLifecycleActionLabel(action, t)}</Text>
          </Pressable>
        </Fragment>;
      })}
    </View> : null}

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
  lifecycleToolbar: { alignItems: 'stretch', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 44, overflow: 'hidden' },
  lifecycleButton: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 44, minWidth: 0, paddingHorizontal: 8, paddingVertical: 6 },
  lifecycleSeparator: { alignSelf: 'center', height: 20, width: StyleSheet.hairlineWidth },
  lifecycleButtonDisabled: { opacity: 0.42 },
  lifecycleButtonText: { flexShrink: 1, fontSize: 13, fontWeight: '500', textAlign: 'center' },
  notice: { alignItems: 'flex-start', borderRadius: 12, flexDirection: 'row', gap: 9, padding: 12 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.65 },
});
