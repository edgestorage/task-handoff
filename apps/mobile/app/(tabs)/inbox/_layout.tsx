import { Stack, router } from 'expo-router';
import { Platform, Pressable } from 'react-native';

import { SystemIcon } from '../../../src/components/SystemIcon';
import { useMobileTheme } from '../../../src/components/theme';
import { useI18n } from '../../../src/i18n';

const supportsScrollEdgeEffects = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

export default function InboxLayout() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const openNewSession = () => router.push('/sessions/new');

  return <Stack screenOptions={{
    contentStyle: { backgroundColor: colors.background },
    headerShadowVisible: false,
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.text, fontSize: 17, fontWeight: '600' },
    title: t('nav.aiSessions'),
    ...(Platform.OS === 'ios' ? {
      headerStyle: { backgroundColor: 'transparent' },
      headerTransparent: true,
      ...(supportsScrollEdgeEffects
        ? { scrollEdgeEffects: { top: 'soft' as const } }
        : { headerBlurEffect: 'systemMaterial' as const }),
      unstable_headerRightItems: () => [{
        accessibilityLabel: t('sessions.newAccessibility'),
        icon: { name: 'plus' as const, type: 'sfSymbol' as const },
        label: t('sessions.newAccessibility'),
        onPress: openNewSession,
        type: 'button' as const,
      }],
    } : {
      headerRight: () => <Pressable accessibilityLabel={t('sessions.newAccessibility')} accessibilityRole="button" hitSlop={10} onPress={openNewSession}><SystemIcon android="add" color={colors.primary} ios="plus" size={20} /></Pressable>,
    }),
  }} />;
}
