import { router, type NativeStackHeaderItem } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useI18n } from '../i18n';
import { useInstanceScope } from '../instance-scope/use-instance-scope';

export function useAppSessionInboxHeaderActions() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { scope } = useInstanceScope();
  const openNewSession = () => router.push(scope.kind === 'instance'
    ? { pathname: '/app-sessions/new', params: { instanceId: scope.instanceId } }
    : '/app-sessions/new');
  const headerRightItems = () => [{
    accessibilityLabel: t('appSessions.newAccessibility'),
    icon: { name: 'plus' as const, type: 'sfSymbol' as const },
    identifier: 'app-session-create',
    label: t('appSessions.newAccessibility'),
    onPress: openNewSession,
    sharesBackground: false,
    tintColor: colors.primary,
    type: 'button' as const,
  }] satisfies NativeStackHeaderItem[];
  const headerRight = () => <Pressable accessibilityLabel={t('appSessions.newAccessibility')} accessibilityRole="button" hitSlop={6} onPress={openNewSession} style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}>
    <Icon color={colors.primary} name="add" size={20} />
  </Pressable>;
  return { headerRight, headerRightItems, openNewSession };
}

const styles = StyleSheet.create({
  headerButton: { alignItems: 'center', height: 34, justifyContent: 'center', width: 32 },
  headerButtonPressed: { opacity: 0.68, transform: [{ scale: 0.96 }] },
});
