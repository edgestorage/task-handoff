import { Boxes, Folder } from 'lucide-react-native';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { AiAgentIcon, aiAgentKind } from '../components/AiAgentIcon';
import { useMobileTheme } from '../components/theme';

export function SessionContextRow({
  agent,
  instanceName,
  instanceTestID = 'session-instance-context',
  style,
  testID = 'session-workspace-context',
  workspace,
}: {
  agent?: string;
  instanceName: string;
  instanceTestID?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  workspace: string;
}) {
  const { colors } = useMobileTheme();
  const agentKind = agent ? aiAgentKind(agent) : undefined;
  return <View style={[styles.row, style]} testID={testID}>
    <View style={styles.contextItem}>
      <Folder color={colors.textMuted} size={14} />
      <Text numberOfLines={1} style={[styles.workspaceName, { color: colors.textMuted }]}>{workspace}</Text>
    </View>
    <Text aria-hidden style={[styles.contextSeparator, { color: colors.textMuted }]}>·</Text>
    <View style={[styles.contextItem, styles.instanceContext]} testID={instanceTestID}>
      <Boxes color={colors.textMuted} size={14} />
      <Text numberOfLines={1} style={[styles.instanceName, { color: colors.textMuted }]}>{instanceName}</Text>
    </View>
    <Text aria-hidden style={[styles.contextSeparator, { color: colors.textMuted }]}>·</Text>
    {agentKind
      ? <AiAgentIcon agent={agentKind} color={colors.textMuted} label={agent || agentKind} />
      : agent ? <Text numberOfLines={1} style={[styles.agentFallback, { color: colors.textMuted }]}>{agent}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', flexDirection: 'row', gap: 6, minWidth: 0, overflow: 'hidden' },
  contextItem: { alignItems: 'center', flexDirection: 'row', flexShrink: 1, gap: 5, minWidth: 0 },
  instanceContext: { flexShrink: 1.2 },
  workspaceName: { flexShrink: 1, fontSize: 13, fontWeight: '400', lineHeight: 20, minWidth: 0 },
  contextSeparator: { flexShrink: 0, fontSize: 13, lineHeight: 20 },
  agentFallback: { flexShrink: 0, fontSize: 13, lineHeight: 20 },
  instanceName: { flexShrink: 1, fontSize: 13, fontWeight: '400', lineHeight: 20, minWidth: 0 },
});
