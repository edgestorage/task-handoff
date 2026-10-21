import { Button, HStack, Host, Image, Label, List, Section, Spacer, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  buttonStyle,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listStyle,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useSyncExternalStore } from 'react';
import { Alert, View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { clearDiagnosticLogs, copyRecentDiagnosticLogs, getDiagnosticLogsEnabled, setDiagnosticLogsEnabled, subscribeDiagnosticLogs } from '../observability/diagnostic-logs';
import { useTaskStatusSettings } from '../task-status/settings';
import type { NativeProfilesScreenProps } from './NativeProfilesScreen';
import { mobileControlPlaneProfileAddress, sameMobileControlPlaneProfileIdentity } from './profile';

export function NativeProfilesScreen(props: NativeProfilesScreenProps) {
  const { colors, dark, preference: appearance, setPreference: setAppearance } = useMobileTheme();
  const { preference, setPreference, t } = useI18n();
  const taskStatus = useTaskStatusSettings();
  const diagnosticsEnabled = useSyncExternalStore(subscribeDiagnosticLogs, getDiagnosticLogsEnabled);

  const copyDiagnostics = async () => {
    try {
      const copied = await copyRecentDiagnosticLogs();
      Alert.alert(t('diagnostics.title'), t(copied ? 'diagnostics.copied' : 'diagnostics.empty'));
    } catch {
      Alert.alert(t('diagnostics.title'), t('diagnostics.copyFailed'));
    }
  };

  const clearDiagnostics = () => {
    Alert.alert(t('diagnostics.clearTitle'), t('diagnostics.clearMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('diagnostics.clear'), style: 'destructive', onPress: () => { void clearDiagnosticLogs().then(() => {
        Alert.alert(t('diagnostics.title'), t('diagnostics.cleared'));
      }).catch(() => {
        Alert.alert(t('diagnostics.title'), t('diagnostics.clearFailed'));
      }); } },
    ]);
  };

  return (
    <View style={{ flex: 1 }}>
      <Host colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} style={{ flex: 1 }}>
        <List modifiers={[listStyle('insetGrouped'), tint(colors.primary)]}>
          {!props.profilesLoaded ? (
            <Section>
              <Label title={t('profiles.loading')} systemImage="arrow.triangle.2.circlepath" />
            </Section>
          ) : <ConnectedProfiles {...props} />}
          <Section title={t('locale.language')}>
            <Button label={`${preference === 'system' ? '✓ ' : ''}${t('locale.system')}`} systemImage="gearshape" onPress={() => { void setPreference('system'); }} />
            <Button label={`${preference === 'en-US' ? '✓ ' : ''}${t('locale.english')}`} systemImage="globe" onPress={() => { void setPreference('en-US'); }} />
            <Button label={`${preference === 'zh-CN' ? '✓ ' : ''}${t('locale.chinese')}`} systemImage="globe" onPress={() => { void setPreference('zh-CN'); }} />
          </Section>
          <Section title={t('appearance.title')}>
            <Button label={`${appearance === 'system' ? '✓ ' : ''}${t('appearance.system')}`} systemImage="gearshape" onPress={() => { void setAppearance('system'); }} />
            <Button label={`${appearance === 'light' ? '✓ ' : ''}${t('appearance.light')}`} systemImage="sun.max" onPress={() => { void setAppearance('light'); }} />
            <Button label={`${appearance === 'dark' ? '✓ ' : ''}${t('appearance.dark')}`} systemImage="moon" onPress={() => { void setAppearance('dark'); }} />
          </Section>
          <Section title={t('diagnostics.title')}>
            <Toggle
              isOn={diagnosticsEnabled}
              label={t('diagnostics.enabled')}
              systemImage="ladybug"
              onIsOnChange={setDiagnosticLogsEnabled}
            />
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
              {t('diagnostics.help')}
            </Text>
            <Button label={t('diagnostics.copyRecent')} systemImage="doc.on.doc" onPress={() => { void copyDiagnostics(); }} />
            <Button label={t('diagnostics.clear')} systemImage="trash" role="destructive" onPress={clearDiagnostics} />
          </Section>
          {taskStatus.available && taskStatus.loaded ? (
            <Section title={t('liveActivity.title')}>
              <Toggle
                isOn={taskStatus.autoStart}
                label={t('liveActivity.autoStart')}
                systemImage="waveform"
                onIsOnChange={(value) => { void taskStatus.setAutoStart(value); }}
              />
              <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
                {t('liveActivity.autoStartHelp')}
              </Text>
            </Section>
          ) : null}
          {props.error ? (
            <Section>
              <Label
                title={props.error}
                systemImage="exclamationmark.triangle.fill"
                modifiers={[foregroundStyle(colors.error)]}
              />
            </Section>
          ) : null}
        </List>
      </Host>
    </View>
  );
}

function ConnectedProfiles(props: NativeProfilesScreenProps) {
  const { t } = useI18n();
  return (
    <>
      <Section title={t('nav.controlPlanes')}>
        {props.profiles.map((profile) => {
          const active = Boolean(props.activeProfile && sameMobileControlPlaneProfileIdentity(props.activeProfile, profile));
          const name = profile.identity.displayName || t('profiles.defaultName');
          const sharedAccess = profile.access.kind === 'cloud-relay' && profile.access.resourceAccess?.kind === 'shared' ? profile.access.resourceAccess : undefined;
          const accessLabel = sharedAccess ? t('cloudControlPlanes.sharedRole', { role: t(sharedAccess.role === 'operator' ? 'controlPlane.roleOperator' : 'controlPlane.roleViewer') }) : undefined;
          return (
            <Button
              key={`${profile.access.kind}:${profile.identity.controlPlaneId}:${profile.identity.publicKeyFingerprint}`}
              modifiers={[buttonStyle('plain'), frame({ maxWidth: Infinity, alignment: 'leading' }), accessibilityLabel(t('profiles.viewDetails', { name }))]}
              onPress={() => props.onOpen(profile)}
            >
              <HStack alignment="center" spacing={12}>
                <Image size={22} systemName="server.rack" />
                <VStack alignment="leading" spacing={3}>
                  <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
                  <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>{accessLabel ? `${accessLabel} · ${mobileControlPlaneProfileAddress(profile)}` : mobileControlPlaneProfileAddress(profile)}</Text>
                </VStack>
                <Spacer />
                {active ? <Image size={17} systemName="checkmark.circle.fill" /> : null}
                <Image size={12} systemName="chevron.right" />
              </HStack>
            </Button>
          );
        })}
      </Section>
      <Section>
        <Button label={t('profiles.add')} systemImage="plus" onPress={props.onAdd} />
      </Section>
    </>
  );
}
