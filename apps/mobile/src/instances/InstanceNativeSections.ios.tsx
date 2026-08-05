import { Button, Form, Host, HStack, Image, Label, LabeledContent, ProgressView, Section, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, font, foregroundStyle, frame, lineLimit, listSectionSpacing } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

import { useMobileTheme } from '../components/theme';
import type { InstanceHistoryProps, InstanceOverviewProps } from './instance-section-types';

export function InstanceOverview(props: InstanceOverviewProps) {
  const { colors, dark } = useMobileTheme();
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={styles.overview}>
    <Form modifiers={[listSectionSpacing('compact')]}>
      <Section title="INSTANCE">
        <ValueRow icon="server.rack" label="Node" value={props.nodeName} />
        <ValueRow icon="shippingbox" label="Runtime" value={props.runtime} />
        <ValueRow icon="folder" label="Workspace" value={props.workspace} />
        <ValueRow icon="clock" label="Heartbeat" value={props.heartbeat} />
        <ValueRow icon={props.protocolCompatible ? 'checkmark.seal' : 'exclamationmark.triangle'} label="Protocol" value={props.protocol} warning={!props.protocolCompatible} />
      </Section>
      <Section>
        <Button label="New AI Session" systemImage="square.and.pencil" onPress={props.onCreateSession} />
        <Button onPress={props.onShowSessions}>
          <HStack spacing={10}>
            <Image color={colors.primary} size={19} systemName="bubble.left.and.bubble.right.fill" />
            <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
              <Text modifiers={[font({ weight: 'semibold' })]}>AI Sessions</Text>
              <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary')]}>{props.activeSessionCount} active · {props.problemSessionCount} need attention</Text>
            </VStack>
            <Image color={colors.textMuted} size={12} systemName="chevron.right" />
          </HStack>
        </Button>
      </Section>
    </Form>
  </Host>;
}

export function InstanceHistory({ items, loading, onOpen }: InstanceHistoryProps) {
  const { colors, dark } = useMobileTheme();
  const height = loading || !items.length ? 138 : Math.min(72 + items.length * 66, 380);
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={[styles.history, { height }]}>
    <Form modifiers={[listSectionSpacing('compact')]}>
      <Section title={`HISTORY${items.length ? ` · ${items.length}` : ''}`}>
        {loading ? <HStack spacing={9}><ProgressView /><Text modifiers={[foregroundStyle('secondary')]}>Loading history…</Text></HStack> : null}
        {!loading && items.map((item) => <Button key={item.id} onPress={() => onOpen(item)} modifiers={[buttonStyle('plain')]}>
          <HStack spacing={10}>
            <Image color={colors.textMuted} size={18} systemName="clock.arrow.circlepath" />
            <VStack alignment="leading" spacing={3} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
              <Text modifiers={[font({ weight: 'semibold' }), lineLimit(2)]}>{item.title || item.userPrompt || 'Archived session'}</Text>
              <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary'), lineLimit(1)]}>{item.agent} · {new Date(item.lastActiveAt).toLocaleString()}</Text>
            </VStack>
            <Image color={colors.textMuted} size={12} systemName="chevron.right" />
          </HStack>
        </Button>)}
        {!loading && !items.length ? <Label title="No archived sessions yet" systemImage="clock.arrow.circlepath" modifiers={[foregroundStyle('secondary')]} /> : null}
      </Section>
    </Form>
  </Host>;
}

function ValueRow({ icon, label, value, warning }: { icon: Parameters<typeof Label>[0]['systemImage']; label: string; value: string; warning?: boolean }) {
  return <LabeledContent label={<Label title={label} systemImage={icon} modifiers={warning ? [foregroundStyle('orange')] : undefined} />}>
    <Text modifiers={[font({ size: 13 }), foregroundStyle(warning ? 'orange' : 'secondary'), lineLimit(2)]}>{value}</Text>
  </LabeledContent>;
}

const styles = StyleSheet.create({
  overview: { alignSelf: 'stretch', height: 390, marginHorizontal: -20 },
  history: { alignSelf: 'stretch', marginHorizontal: -20 },
});
