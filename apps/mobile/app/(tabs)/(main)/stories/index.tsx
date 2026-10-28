import { router } from 'expo-router';
import { Platform } from 'react-native';
import { AiSessionDetailScreen } from '../../../../src/ai-sessions/AiSessionDetailScreen';
import { EmptyState } from '../../../../src/components/EmptyState';
import { MasterDetailEmptyState, MasterDetailLayout, useMasterDetailBack, useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { NativeSplitEmptyDetail } from '../../../../src/components/NativeSplitEmptyDetail';
import { iosSplitDetailHeaderOptions, iosSplitListHeaderOptions } from '../../../../src/components/navigation-header';
import { Screen } from '../../../../src/components/Screen';
import { useMobileTheme } from '../../../../src/components/theme';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../../src/i18n';
import { useOpenInstanceDrawer } from '../../../../src/instance-scope/use-open-instance-drawer';
import { storyDetailSelection, storySessionDetailSelection, useDetailSelection } from '../../../../src/master-detail/selection';
import { useCompactDetailOnResize } from '../../../../src/master-detail/use-compact-detail-on-resize';
import { StoryDetail } from '../../../../src/stories/StoryDetail';
import { StoryNodeFilterHeaderButton } from '../../../../src/stories/StoryNodeFilterHeaderButton';
import { StoryInbox } from '../../../../src/stories/StoryInbox';
import { useStoryInboxHeaderActions } from '../../../../src/stories/use-story-inbox-header-actions';

export default function StoriesRoute() {
  const runtime = useMobileControlPlaneRuntime();
  const { t } = useI18n();
  const { dark } = useMobileTheme();
  const { wide } = useMasterDetailLayout();
  const openDrawer = useOpenInstanceDrawer();
  const storyHeader = useStoryInboxHeaderActions();
  const storedSelection = useDetailSelection(storyDetailSelection);
  const storedSession = useDetailSelection(storySessionDetailSelection);
  const selected = storedSelection?.controlPlaneId === runtime.controlPlaneId ? storedSelection : undefined;
  const selectedSession = storedSession
    && storedSession.controlPlaneId === runtime.controlPlaneId
    && selected
    && selected.nodeId === storedSession.nodeId
    && selected.storyId === storedSession.storyId
    ? storedSession
    : undefined;
  const detailHref = selectedSession ? {
    pathname: '/sessions/[instanceId]/[sessionId]' as const,
    params: { instanceId: selectedSession.instanceId, sessionId: selectedSession.sessionId },
  } : selected ? {
    pathname: '/stories/[storyId]' as const,
    params: { nodeId: selected.nodeId, storyId: selected.storyId },
  } : undefined;
  const openStory = (story: { id: string; ownerNodeId: string }) => {
    storySessionDetailSelection.clear();
    if (runtime.controlPlaneId) storyDetailSelection.set({ controlPlaneId: runtime.controlPlaneId, nodeId: story.ownerNodeId, storyId: story.id });
    if (!wide) router.push({ pathname: '/stories/[storyId]' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } });
  };
  const openSession = (story: { nodeId: string; storyId: string }, instanceId: string, sessionId: string) => {
    if (!runtime.controlPlaneId) return;
    const storySelection = { controlPlaneId: runtime.controlPlaneId, nodeId: story.nodeId, storyId: story.storyId };
    storyDetailSelection.set(storySelection);
    storySessionDetailSelection.set({ ...storySelection, instanceId, sessionId });
    if (!wide) router.push({ pathname: '/sessions/[instanceId]/[sessionId]', params: { instanceId, sessionId } });
  };
  const openSelectedSession = (instanceId: string, sessionId: string) => {
    if (selected) openSession(selected, instanceId, sessionId);
  };
  useCompactDetailOnResize({ enabled: Boolean(selectedSession || selected), href: detailHref, wide });
  useMasterDetailBack(wide, Boolean(selectedSession || selected), () => {
    if (selectedSession) storySessionDetailSelection.clear();
    else storyDetailSelection.clear();
  });
  if (!runtime.storyCapability) {
    return <Screen><EmptyState icon="book-outline" message={t('stories.unsupported')} style={{ flex: 1 }} /></Screen>;
  }
  const splitView = Platform.OS === 'ios' && wide;
  const nativeSplitOptions = splitView ? {
    detail: iosSplitDetailHeaderOptions(dark, t('stories.singular')),
    list: {
      ...iosSplitListHeaderOptions(dark, t('nav.stories')),
      headerLeft: () => <StoryNodeFilterHeaderButton onPress={openDrawer} />,
      ...(storyHeader.headerRightItems ? { unstable_headerRightItems: storyHeader.headerRightItems } : {}),
    },
  } : undefined;
  return <MasterDetailLayout
    detail={selectedSession && selected ? <AiSessionDetailScreen
      embeddedHeader={Boolean(nativeSplitOptions)}
      instanceId={selectedSession.instanceId}
      key={`${selectedSession.instanceId}:${selectedSession.sessionId}`}
      onClosed={() => storySessionDetailSelection.clear()}
      onOpenSession={openSelectedSession}
      pane
      sessionId={selectedSession.sessionId}
    /> : selected ? <StoryDetail
      embeddedHeader={Boolean(nativeSplitOptions)}
      key={`${selected.nodeId}:${selected.storyId}`}
      nodeId={selected.nodeId}
      onDeleted={() => {
        storySessionDetailSelection.clear();
        storyDetailSelection.clear();
      }}
      onOpenSession={openSelectedSession}
      pane
      storyId={selected.storyId}
    /> : undefined}
    emptyDetail={nativeSplitOptions ? <NativeSplitEmptyDetail icon="book-outline" message={t('masterDetail.selectStory')} testID="story-detail-empty" title={t('stories.singular')} /> : <MasterDetailEmptyState icon="book-outline" message={t('masterDetail.selectStory')} testID="story-detail-empty" />}
    list={<StoryInbox
      onAddAction={(story) => router.push({ pathname: '/stories/[storyId]/actions/new' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}
      onAddAutomation={(story) => router.push({ pathname: '/stories/[storyId]/automations/new' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}
      onAddExisting={(story) => router.push({ pathname: '/stories/[storyId]/sessions/assign' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}
      onEdit={(story) => router.push({ pathname: '/stories/[storyId]/edit' as never, params: { storyId: story.id, nodeId: story.ownerNodeId } })}
      onNewSession={(story, defaults) => router.push({
        pathname: '/sessions/new',
        params: {
          instanceId: defaults.instanceId,
          storyId: story.id,
          ...(defaults.cwd ? { cwd: defaults.cwd } : {}),
          ...(defaults.cwdFolderId ? { cwdFolderId: defaults.cwdFolderId } : {}),
          ...(defaults.sessionId ? { worktreeSessionId: defaults.sessionId } : {}),
        },
      })}
      onOpen={openStory}
      onOpenDocument={(story, document) => router.push({ pathname: '/stories/[storyId]/documents/preview' as never, params: { storyId: story.id, nodeId: story.ownerNodeId, storyPath: document.storyPath, title: document.title } })}
      onOpenSession={(story, instanceId, sessionId) => openSession({ nodeId: story.ownerNodeId, storyId: story.id }, instanceId, sessionId)}
      selected={wide ? selectedSession ?? selected : undefined}
    />}
    nativeSplitOptions={nativeSplitOptions}
    testID="story-workbench"
  />;
}
