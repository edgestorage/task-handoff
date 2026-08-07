import { Pressable, StyleSheet, Text } from 'react-native';

import { SystemIcon } from '../components/SystemIcon';
import { useMobileTheme } from '../components/theme';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { useInstanceScope } from './use-instance-scope';
import { useOpenInstanceDrawer } from './use-open-instance-drawer';

export function InstanceScopeHeaderButton() {
  const { colors } = useMobileTheme();
  const { t } = useI18n();
  const { state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const openDrawer = useOpenInstanceDrawer();
  const selected = scope.kind === 'instance' ? state.instances.find((instance) => instance.id === scope.instanceId) : undefined;
  const label = selected?.name || (scope.kind === 'instance' ? scope.instanceId : t('scope.allInstances'));
  return <Pressable accessibilityRole="button" onPress={openDrawer} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
    <SystemIcon android={scope.kind === 'all' ? 'select_all' : 'deployed_code'} color={colors.primary} ios={scope.kind === 'all' ? 'square.grid.2x2' : 'shippingbox'} size={17} />
    <Text numberOfLines={1} style={[styles.label, { color: colors.primary }]}>{label}</Text>
    <SystemIcon android="expand_more" color={colors.primary} ios="chevron.down" size={10} />
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', flexDirection: 'row', gap: 6, maxWidth: 166, minHeight: 34, paddingHorizontal: 6 },
  label: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.55 },
});
