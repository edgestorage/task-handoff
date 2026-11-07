import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { ScopeHeaderButton } from './ScopeHeaderButton';
import { useInstanceScope } from './use-instance-scope';
import { useOpenInstanceDrawer } from './use-open-instance-drawer';

export function InstanceScopeHeaderButton({ onPress, syncTopic = 'instances' }: { onPress?(): void; syncTopic?: string } = {}) {
  const { t } = useI18n();
  const { state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const openDrawer = useOpenInstanceDrawer();
  const handlePress = onPress ?? openDrawer;
  const selected = scope.kind === 'instance' ? state.instances.find((instance) => instance.id === scope.instanceId) : undefined;
  const label = selected?.name || (scope.kind === 'instance' ? scope.instanceId : t('scope.allInstances'));
  return <ScopeHeaderButton syncTopic={syncTopic} icon={scope.kind === 'all' ? 'grid-outline' : 'layers-outline'} label={label} onPress={handlePress} />;
}
