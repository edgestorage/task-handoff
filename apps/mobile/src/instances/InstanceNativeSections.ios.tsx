import { Button, Form, Host, HStack, Image, Label, LabeledContent, ProgressView, Section, Text, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, font, foregroundStyle, frame, lineLimit, listSectionSpacing } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { InstanceHistoryProps, InstanceOverviewProps } from './instance-section-types';

export function InstanceOverview(props: InstanceOverviewProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const overviewHeight = overviewBaseHeight + overviewActionCount * overviewActionHeight + overviewFormBottomInset;
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={[styles.overview, { height: overviewHeight }]}>
    <Form modifiers={[listSectionSpacing('compact')]}>
      <Section title={t('nav.instance').toLocaleUpperCase()}>
        <ValueRow icon="server.rack" label={t('nav.node')} value={props.nodeName} />
        <ValueRow icon="shippingbox" label={t('instance.runtime')} value={props.runtime} />
        <ValueRow icon="folder" label={t('instance.workspace')} value={props.workspace} />
        <ValueRow icon="clock" label={t('instance.heartbeat')} value={props.heartbeat} />
        <ValueRow icon={props.protocolCompatible ? 'checkmark.seal' : 'exclamationmark.triangle'} label={t('instance.protocol')} value={props.protocol} warning={!props.protocolCompatible} />
      </Section>
      <Section>
        <Button label={t('nav.newSession')} systemImage="square.and.pencil" onPress={props.onCreateSession} />
        <Button onPress={props.onShowSessions}>
          <HStack spacing={10}>
            <Image color={colors.primary} size={19} systemName="bubble.left.and.bubble.right.fill" />
            <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
              <Text modifiers={[font({ weight: 'semibold' })]}>{t('nav.aiSessions')}</Text>
              <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary')]}>{t('instance.sessionSummary', { active: props.activeSessionCount, problem: props.problemSessionCount })}</Text>
            </VStack>
            <Image color={colors.textMuted} size={12} systemName="chevron.right" />
          </HStack>
        </Button>
        <Button label={t('nav.history')} systemImage="clock.arrow.circlepath" onPress={props.onShowHistory} />
      </Section>
    </Form>
  </Host>;
}

export function InstanceHistory({ items, loading, onOpen, standalone = false }: InstanceHistoryProps) {
  const { colors, dark } = useMobileTheme();
  const { locale, t } = useI18n();
  const height = loading || !items.length ? 138 : Math.min(72 + items.length * 66, 380);
  return <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={standalone ? styles.historyStandalone : [styles.history, { height }]}>
    <Form modifiers={[listSectionSpacing('compact')]}>
      <Section title={standalone ? undefined : `${t('instance.history')}${items.length ? ` · ${items.length}` : ''}`}>
        {loading ? <HStack spacing={9}><ProgressView /><Text modifiers={[foregroundStyle('secondary')]}>{t('history.loading')}</Text></HStack> : null}
        {!loading && items.map((item) => <Button key={item.id} onPress={() => onOpen(item)} modifiers={[buttonStyle('plain')]}>
          <HStack spacing={10}>
            <Image color={colors.textMuted} size={18} systemName="clock.arrow.circlepath" />
            <VStack alignment="leading" spacing={3} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
              <Text modifiers={[font({ weight: 'semibold' }), lineLimit(2)]}>{item.title || item.userPrompt || t('instance.archivedSession')}</Text>
              <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary'), lineLimit(1)]}>{item.agent} · {new Date(item.lastActiveAt).toLocaleString(locale)}</Text>
            </VStack>
            <Image color={colors.textMuted} size={12} systemName="chevron.right" />
          </HStack>
        </Button>)}
        {!loading && !items.length ? <Label title={t('instance.archivedEmpty')} systemImage="clock.arrow.circlepath" modifiers={[foregroundStyle('secondary')]} /> : null}
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
  overview: { alignSelf: 'stretch', marginHorizontal: -20 },
  history: { alignSelf: 'stretch', marginHorizontal: -20 },
  historyStandalone: { flex: 1 },
});

const overviewBaseHeight = 286;
const overviewActionCount = 3;
const overviewActionHeight = 52;
const overviewFormBottomInset = 52;
