import { Fragment } from 'react';
import { Button, Divider, HStack, Host, Image, Label, LabeledContent, List, ProgressView, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { accessibilityLabel, background, buttonStyle, controlSize, disabled as disabledModifier, font, foregroundStyle, frame, lineLimit, listStyle, padding, scrollContentBackground, shapes, tint } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { InstanceDetailContentProps } from './instance-detail-content-types';
import { instanceControlActions, instanceLifecycleActionLabel } from './instance-lifecycle';

export function InstanceDetailContent(props: InstanceDetailContentProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const lifecycleActions = instanceControlActions(props.actions);
  const statusColor = props.statusTone === 'healthy' ? '#34c759' : props.statusTone === 'error' ? colors.error : colors.textMuted;

  return <View style={{ flex: 1 }}>
    <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }}>
      <List modifiers={[listStyle('insetGrouped'), tint(colors.primary), scrollContentBackground('hidden'), background(colors.background)]}>
        <Section>
          <LabeledContent label={<Label title={t('directories.status')} systemImage="circle.fill" modifiers={[foregroundStyle(statusColor)]} />}>
            <HStack spacing={7}>
              {props.lifecycleAction ? <ProgressView modifiers={[controlSize('small')]} /> : null}
              <Text modifiers={[font({ size: 13 }), foregroundStyle(statusColor), lineLimit(2)]}>{props.status}</Text>
            </HStack>
          </LabeledContent>
          {lifecycleActions.length ? <HStack spacing={0} modifiers={[
            padding({ vertical: 3 }),
            background(colors.background, shapes.roundedRectangle({ cornerRadius: 10, roundedCornerStyle: 'continuous' })),
            frame({ maxWidth: Infinity }),
          ]}>
            {lifecycleActions.map((action, index) => {
              const enabled = !props.lifecycleAction && props.actions.includes(action);
              const destructive = action === 'stop';
              const busy = props.lifecycleAction === action;
              const color = busy || enabled ? destructive ? colors.error : colors.primary : colors.textMuted;
              const systemImage = action === 'start' ? 'play.fill' : action === 'stop' ? 'stop.fill' : 'arrow.clockwise';
              const label = instanceLifecycleActionLabel(action, t);
              return <Fragment key={action}>
                {index ? <Divider modifiers={[frame({ height: 20 })]} /> : null}
                <Button
                  role={destructive ? 'destructive' : 'default'}
                  onPress={() => props.onLifecycleAction(action)}
                  modifiers={[
                    buttonStyle('plain'),
                    controlSize('small'),
                    frame({ maxWidth: Infinity, minHeight: 38 }),
                    tint(color),
                    disabledModifier(!enabled),
                    accessibilityLabel(label),
                  ]}
                >
                  <HStack alignment="center" spacing={6}>
                    {busy ? <ProgressView modifiers={[controlSize('small')]} /> : <Image color={color} size={15} systemName={systemImage} />}
                    <Text modifiers={[font({ size: 13, weight: 'medium' }), foregroundStyle(color), lineLimit(1)]}>{label}</Text>
                  </HStack>
                </Button>
              </Fragment>;
            })}
          </HStack> : null}
        </Section>

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
          <Button onPress={props.onShowWorktrees}>
            <HStack spacing={10}>
              <Image color={colors.primary} size={19} systemName="square.stack.3d.up" />
              <VStack alignment="leading" spacing={2} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>
                <Text modifiers={[font({ weight: 'semibold' })]}>{t('repository.worktrees.sectionTitle')}</Text>
                <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary'), lineLimit(2)]}>{t('repository.worktrees.sectionDescription')}</Text>
              </VStack>
              <Spacer />
              <Image color={colors.textMuted} size={12} systemName="chevron.right" />
            </HStack>
          </Button>
        </Section>

        {props.protocolWarning || props.error ? <Section>
          {props.protocolWarning ? <Label title={props.protocolWarning} systemImage="exclamationmark.triangle.fill" modifiers={[foregroundStyle(colors.noticeText)]} /> : null}
          {props.error ? <Label title={`${props.error.code}: ${props.error.message}`} systemImage="xmark.octagon.fill" modifiers={[foregroundStyle(colors.error)]} /> : null}
        </Section> : null}
      </List>
    </Host>
  </View>;
}

function ValueRow({ icon, label, value, warning }: { icon: Parameters<typeof Label>[0]['systemImage']; label: string; value: string; warning?: boolean }) {
  return <LabeledContent label={<Label title={label} systemImage={icon} modifiers={warning ? [foregroundStyle('orange')] : undefined} />}>
    <Text modifiers={[font({ size: 13 }), foregroundStyle(warning ? 'orange' : 'secondary'), lineLimit(2)]}>{value}</Text>
  </LabeledContent>;
}
