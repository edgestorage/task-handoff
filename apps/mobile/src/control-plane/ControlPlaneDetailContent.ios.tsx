import { Button, Host, Label, LabeledContent, List, ProgressView, Section, Text } from '@expo/ui/swift-ui';
import { disabled, font, foregroundStyle, lineLimit, listStyle, textSelection, tint } from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import type { ControlPlaneDetailContentProps } from './ControlPlaneDetailContent';
import { controlPlaneRoleMessageKey } from './current-access';
import { mobileControlPlaneProfileAddress } from './profile';

export function ControlPlaneDetailContent(props: ControlPlaneDetailContentProps) {
  const { colors, dark } = useMobileTheme();
  const { t } = useI18n();
  const secondaryText = [font({ size: 13 }), foregroundStyle('secondary'), lineLimit(2), textSelection(true)];

  return (
    <View style={{ flex: 1 }}>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }}>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary)]}>
          <Section
            title={t('controlPlane.connection')}
            footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('controlPlane.fingerprintHelp')}</Text>}
          >
            <LabeledContent label={<Label title={t('controlPlane.status')} systemImage={props.active ? 'checkmark.circle.fill' : 'circle'} />}>
              <Text modifiers={[font({ size: 13 }), foregroundStyle(props.active ? colors.primary : 'secondary')]}>
                {props.active ? t('controlPlane.active') : t('controlPlane.saved')}
              </Text>
            </LabeledContent>
            <ValueRow label={t('controlPlane.address')} systemImage="link" value={mobileControlPlaneProfileAddress(props.profile)} modifiers={secondaryText} />
            <ValueRow label={t('controlPlane.id')} systemImage="number" value={props.profile.identity.controlPlaneId} modifiers={secondaryText} />
            <ValueRow label={t('controlPlane.fingerprint')} systemImage="checkmark.seal" value={props.profile.identity.publicKeyFingerprint} modifiers={secondaryText} />
            {props.currentAccess ? <>
              <ValueRow label={t('controlPlane.memberRole')} systemImage="person.badge.key" value={props.currentAccess.roleIds.map((roleId) => { const key = controlPlaneRoleMessageKey(roleId); return key ? t(key) : roleId; }).join(', ')} modifiers={secondaryText} />
              <ValueRow label={t('controlPlane.nodeAccess')} systemImage="server.rack" value={props.currentAccess.nodeScope.kind === 'all' ? t('controlPlane.allNodes') : t('controlPlane.selectedNodes', { count: props.currentAccess.nodeScope.nodeIds.length })} modifiers={secondaryText} />
              <ValueRow label={t('controlPlane.authorizationRevision')} systemImage="arrow.triangle.2.circlepath" value={String(props.currentAccess.authorizationRevision)} modifiers={secondaryText} />
            </> : null}
          </Section>

          <Section
            title={t('controlPlane.actions')}
            footer={<Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle('secondary')]}>{t('controlPlane.removeHelp')}</Text>}
          >
            {!props.active ? (
              <Button
                label={t('controlPlane.makeActive')}
                systemImage="checkmark.circle"
                onPress={props.onMakeActive}
                modifiers={[disabled(props.busy)]}
              />
            ) : null}
            <Button
              label={t('controlPlane.remove')}
              systemImage="trash"
              role="destructive"
              onPress={props.onRemove}
              modifiers={[foregroundStyle(colors.error), disabled(props.busy)]}
            />
          </Section>

          {props.busy ? (
            <Section>
              {props.busy ? <LabeledContent label={t('controlPlane.updating')}><ProgressView /></LabeledContent> : null}
            </Section>
          ) : null}
        </List>
      </Host>
    </View>
  );
}

function ValueRow({ label, modifiers, systemImage, value }: {
  label: string;
  modifiers: NonNullable<Parameters<typeof Text>[0]['modifiers']>;
  systemImage: Parameters<typeof Label>[0]['systemImage'];
  value: string;
}) {
  return (
    <LabeledContent label={<Label title={label} systemImage={systemImage} />}>
      <Text modifiers={modifiers}>{value}</Text>
    </LabeledContent>
  );
}
