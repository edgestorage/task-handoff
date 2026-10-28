import { Pressable, StyleSheet, Text } from 'react-native';

import { Icon } from '../components/Icon';
import { useMobileTheme } from '../components/theme';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { useInstanceScope } from './use-instance-scope';
import { useOpenInstanceDrawer } from './use-open-instance-drawer';

export function InstanceScopeHeaderButton({ onPress }: { onPress?(): void } = {}) {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const openDrawer = useOpenInstanceDrawer();
  const handlePress = onPress ?? openDrawer;
  const selected = scope.kind === 'instance' ? state.instances.find((instance) => instance.id === scope.instanceId) : undefined;
  const label = selected?.name || (scope.kind === 'instance' ? scope.instanceId : t('scope.allInstances'));
  return <Pressable accessibilityRole="button" onPress={handlePress} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
    <Icon color={colors.primary} name={scope.kind === 'all' ? 'grid-outline' : 'layers-outline'} size={17} />
    <Text numberOfLines={1} style={[styles.label, { color: colors.primary }]}>{label}</Text>
    <Icon color={colors.primary} name="chevron-down" size={10} />
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', flexDirection: 'row', gap: 6, maxWidth: 166, minHeight: 34, paddingHorizontal: 6 },
  label: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.55 },
});
