import { router } from 'expo-router';
import { Platform } from 'react-native';
import { MasterDetailEmptyState, MasterDetailLayout, useMasterDetailBack, useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { NativeSplitEmptyDetail } from '../../../../src/components/NativeSplitEmptyDetail';
import { iosSplitDetailHeaderOptions, iosSplitListHeaderOptions } from '../../../../src/components/navigation-header';
import { useMobileTheme } from '../../../../src/components/theme';
import { InstancesDirectory } from '../../../../src/directories/DirectoryLists';
import { useActiveDirectories } from '../../../../src/directories/use-directories';
import { useI18n } from '../../../../src/i18n';
import { InstanceScopeHeaderButton } from '../../../../src/instance-scope/InstanceScopeHeaderButton';
import { useInstanceScope } from '../../../../src/instance-scope/use-instance-scope';
import { useOpenInstanceDrawer } from '../../../../src/instance-scope/use-open-instance-drawer';
import { InstanceDetailScreen } from '../../../../src/instances/InstanceDetailScreen';
import { instanceDetailSelection, useDetailSelection } from '../../../../src/master-detail/selection';
import { useCompactDetailOnResize } from '../../../../src/master-detail/use-compact-detail-on-resize';

export default function InstancesRoute() {
  const { controlPlaneId, refresh, state } = useActiveDirectories();
  const { scope } = useInstanceScope();
  const { t } = useI18n();
  const { dark } = useMobileTheme();
  const { wide } = useMasterDetailLayout();
  const openDrawer = useOpenInstanceDrawer();
  const storedSelection = useDetailSelection(instanceDetailSelection);
  const visible = scope.kind === 'instance' ? { ...state, instances: state.instances.filter((instance) => instance.id === scope.instanceId) } : state;
  const selected = storedSelection && storedSelection.controlPlaneId === controlPlaneId && visible.instances.some((instance) => instance.id === storedSelection.instanceId)
    ? storedSelection
    : undefined;
  const detailHref = selected ? {
    pathname: '/instances/[instanceId]' as const,
    params: { instanceId: selected.instanceId },
  } : undefined;
  const openInstance = (instance: { id: string }) => {
    if (controlPlaneId) instanceDetailSelection.set({ controlPlaneId, instanceId: instance.id });
    if (!wide) router.push({ pathname: '/instances/[instanceId]', params: { instanceId: instance.id } });
  };
  useCompactDetailOnResize({ enabled: Boolean(selected), href: detailHref, wide });
  useMasterDetailBack(wide, Boolean(selected), () => instanceDetailSelection.clear());
  const splitView = Platform.OS === 'ios' && wide;
  const nativeSplitOptions = splitView ? {
    detail: iosSplitDetailHeaderOptions(dark, t('nav.instance')),
    list: {
      ...iosSplitListHeaderOptions(dark, t('nav.instances')),
      headerLeft: () => <InstanceScopeHeaderButton onPress={openDrawer} />,
    },
  } : undefined;
  return <MasterDetailLayout
    detail={selected ? <InstanceDetailScreen
      embeddedHeader={Boolean(nativeSplitOptions)}
      instanceId={selected.instanceId}
      key={`${controlPlaneId || ''}:${selected.instanceId}`}
      pane
    /> : undefined}
    emptyDetail={nativeSplitOptions ? <NativeSplitEmptyDetail icon="layers-outline" message={t('masterDetail.selectInstance')} testID="instance-detail-empty" title={t('nav.instance')} /> : <MasterDetailEmptyState icon="layers-outline" message={t('masterDetail.selectInstance')} testID="instance-detail-empty" />}
    list={<InstancesDirectory
      onOpen={openInstance}
      onRefresh={refresh}
      selectedInstanceId={wide ? selected?.instanceId : undefined}
      state={visible}
    />}
    nativeSplitOptions={nativeSplitOptions}
    testID="instance-workbench"
  />;
}
