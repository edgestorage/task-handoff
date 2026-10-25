import { router } from 'expo-router';
import { AiSessionDetailScreen } from '../../../../src/ai-sessions/AiSessionDetailScreen';
import { EmptyState } from '../../../../src/components/EmptyState';
import { MasterDetailEmptyState, MasterDetailLayout, useMasterDetailBack, useMasterDetailLayout } from '../../../../src/components/MasterDetailLayout';
import { Screen } from '../../../../src/components/Screen';
import { useMobileControlPlaneRuntime } from '../../../../src/control-plane/use-mobile-control-plane-runtime';
import { useI18n } from '../../../../src/i18n';
import { storyDetailSelection, storySessionDetailSelection, useDetailSelection } from '../../../../src/master-detail/selection';
import { useCompactDetailOnResize } from '../../../../src/master-detail/use-compact-detail-on-resize';
import { StoryDetail } from '../../../../src/stories/StoryDetail';
import { StoryInbox } from '../../../../src/stories/StoryInbox';

export default function StoriesRoute() {
  const runtime = useMobileControlPlaneRuntime();
  const { t } = useI18n();
  const { wide } = useMasterDetailLayout();
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
  return <MasterDetailLayout
    detail={selectedSession && selected ? <AiSessionDetailScreen
      instanceId={selectedSession.instanceId}
      key={`${selectedSession.instanceId}:${selectedSession.sessionId}`}
      onClosed={() => storySessionDetailSelection.clear()}
      onOpenSession={openSelectedSession}
      pane
      sessionId={selectedSession.sessionId}
    /> : selected ? <StoryDetail
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
    emptyDetail={<MasterDetailEmptyState icon="book-outline" message={t('masterDetail.selectStory')} testID="story-detail-empty" />}
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
    testID="story-workbench"
  />;
}
