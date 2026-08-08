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
import { View } from 'react-native';

import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { useTaskStatusSettings } from '../task-status/settings';
import type { NativeProfilesScreenProps } from './NativeProfilesScreen';

export function NativeProfilesScreen(props: NativeProfilesScreenProps) {
  const { colors, dark, preference: appearance, setPreference: setAppearance } = useMobileTheme();
  const { preference, setPreference, t } = useI18n();
  const taskStatus = useTaskStatusSettings();

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
          const active = props.activeId === profile.identity.controlPlaneId;
          const name = profile.identity.displayName || t('profiles.defaultName');
          return (
            <Button
              key={`${profile.identity.controlPlaneId}:${profile.identity.publicKeyFingerprint}`}
              modifiers={[buttonStyle('plain'), frame({ maxWidth: Infinity, alignment: 'leading' }), accessibilityLabel(t('profiles.viewDetails', { name }))]}
              onPress={() => props.onOpen(profile.identity.controlPlaneId)}
            >
              <HStack alignment="center" spacing={12}>
                <Image size={22} systemName="server.rack" />
                <VStack alignment="leading" spacing={3}>
                  <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
                  <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle({ type: 'hierarchical', style: 'secondary' }), lineLimit(1)]}>{profile.access.origin}</Text>
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
