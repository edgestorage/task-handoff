import { EmptyState } from '../components/EmptyState';
import { Screen } from '../components/Screen';
import { useActiveDirectories } from '../directories/use-directories';
import { useI18n } from '../i18n';
import { InstanceWorktreesSection } from './InstanceWorktreesSection';

export function InstanceWorktreesScreen({ instanceId }: { instanceId: string }) {
  const { state } = useActiveDirectories();
  const { t } = useI18n();
  const instance = state.instances.find((candidate) => candidate.id === instanceId);

  if (!instance) {
    return <Screen contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}><EmptyState icon="layers-outline" message={t('instance.notFound')} /></Screen>;
  }

  return <Screen>
    <InstanceWorktreesSection instanceId={instance.id} nodeId={instance.nodeId} standalone workspacePath={instance.workspace.path || undefined} />
  </Screen>;
}
