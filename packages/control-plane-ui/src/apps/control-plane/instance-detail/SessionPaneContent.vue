<template>
  <div class="session-pane-content">
    <div v-if="hasInstanceStatusPage(instance)" class="session-preview-status-page" :data-pending="isInstanceStatusPending(instance)" :data-state="instance.status">
      <div v-if="showImagePreparation" class="session-status-image-layout">
        <div class="session-status-overview">
          <RefreshCw v-if="instance.imageProvisioning?.phase !== 'failed'" :size="34" />
          <CircleAlert v-else :size="34" />
          <div>
            <strong>{{ instanceStatusTitle(instance, t) }}</strong>
            <span>{{ instanceStatusDetail(instance, t) }}</span>
          </div>
        </div>
        <ol class="image-preparation-steps" :aria-label="t('instances.imagePull.preparationStages')">
          <li v-for="(step, index) in imagePreparationSteps" :key="step" :data-state="imagePreparationStepState(index)">
            <i>{{ index + 1 }}</i>
            <span>{{ step }}</span>
          </li>
        </ol>
        <ImagePullStatus
          v-if="instance.imagePullProgress"
          class="session-status-image-pull"
          :progress="instance.imagePullProgress"
        />
        <span v-else class="session-status-image-note">{{ t("instances.imagePull.waitingForOutput") }}</span>
      </div>
      <template v-else>
        <RefreshCw v-if="isInstanceStatusPending(instance)" :size="34" />
        <CircleAlert v-else-if="instance.status === 'failed' || instance.status === 'unhealthy'" :size="34" />
        <PowerOff v-else :size="34" />
        <strong>{{ instanceStatusTitle(instance, t) }}</strong>
        <span>{{ instanceStatusDetail(instance, t) }}</span>
        <div v-if="hasStatusActions" class="session-status-actions" :aria-label="t('instances.detail.controls')">
          <Button v-if="canShowInstanceAction(instance, 'start')" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'start', instance)">
            <Play :size="14" />
            <span>{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</span>
          </Button>
          <Button v-if="canShowInstanceAction(instance, 'stop')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'stop', instance)">
            <Square :size="14" />
            <span>{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</span>
          </Button>
          <Button v-if="canShowInstanceAction(instance, 'restart')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'restart', instance)">
            <RotateCw :size="14" />
            <span>{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</span>
          </Button>
          <Button v-if="canShowInstanceAction(instance, 'retry-image')" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'retry-image', instance)">
            <RotateCw :size="14" />
            <span>{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</span>
          </Button>
        </div>
      </template>
    </div>
    <AiSessionPanel
      v-else-if="session?.kind === 'ai'"
      :active-session="session"
      :instance="instance"
      :launchable-apps="launchableApps"
      :node-local-folders="nodeLocalFolders"
      :selected-ai-session="selectedAiSession"
      @open-ai-session-app="(target, aiSession) => $emit('openAiSessionApp', target, aiSession)"
      @open-repository-workspace="$emit('openRepositoryWorkspace', $event)"
      @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
    />
    <RepositoryChangesReviewTab v-else-if="session?.kind === 'repository' && session.source?.page === 'changes-review'" :instance-id="instance.id" :session="session" @open-workspace="$emit('openRepositoryWorkspace', $event)" />
    <RepositoryWorktreesTab v-else-if="session?.kind === 'repository' && session.source?.page === 'worktrees'" :instance-id="instance.id" :session="session" />
    <RepositoryWorkspaceTab v-else-if="session?.kind === 'repository'" :instance-id="instance.id" :session="session" @open-workspace="$emit('openRepositoryWorkspace', $event)" />
    <div v-else-if="activeFrameUrl" class="session-preview-live">
      <iframe class="session-preview-frame" :src="activeFrameUrl" :title="session?.label || t('sessions.tabs.appSession')" allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
    <div v-else-if="!activeTerminalSocketUrl" class="session-preview-body">
      <Terminal v-if="session?.kind === 'terminal'" :size="34" />
      <Monitor v-else :size="34" />
      <strong>{{ previewTitle(instance, t) }}</strong>
      <Button v-if="canLaunchApp" variant="outline" size="sm" class="session-preview-launch-button" :disabled="launchingApp" :title="appLaunchButtonTitle" @click="$emit('openLaunchMenu')">
        <Plus :size="15" />
        <span>{{ t("sessions.tabs.app") }}</span>
      </Button>
      <span v-else>{{ previewDetail(instance, t, locale as SupportedLocale) }}</span>
    </div>
    <SessionTerminalPreview
      v-if="!hasInstanceStatusPage(instance) && activeTerminalSocketUrl"
      active
      :cache-key="sessionKey"
      :cache-scope="instance.id"
      :socket-url="activeTerminalSocketUrl"
      class="session-preview-live session-terminal"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { SupportedLocale } from "../../../i18n/locale";
import { CircleAlert, Monitor, Play, Plus, PowerOff, RefreshCw, RotateCw, Square, Terminal } from "@lucide/vue";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import type { InstanceAction } from "../useInstanceActions";
import type { LaunchableApp, RepositoryWorkspaceTabTarget, SessionTab } from "../useInstanceSessions";
import { previewDetail, previewTitle, sessionFrameUrl, sessionTerminalSocketUrl } from "../useInstanceSessions";
import { canShowInstanceAction, hasInstanceStatusPage, instanceStatusDetail, instanceStatusTitle, isInstanceStatusPending } from "../useInstanceStatus";
import AiSessionPanel from "./AiSessionPanel.vue";
import SessionTerminalPreview from "./SessionTerminalPreview.vue";
import RepositoryChangesReviewTab from "./RepositoryChangesReviewTab.vue";
import RepositoryWorktreesTab from "./RepositoryWorktreesTab.vue";
import RepositoryWorkspaceTab from "./RepositoryWorkspaceTab.vue";
import ImagePullStatus from "./ImagePullStatus.vue";

const { locale, t } = useI18n();

const props = defineProps<{
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  appLaunchButtonTitle: string;
  canLaunchApp: boolean;
  instance: InstanceWithAiSessions;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  launchableApps: LaunchableApp[];
  launchingApp: boolean;
  nodeLocalFolders?: NodeLocalFolder[];
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
  session?: SessionTab;
  sessionKey: string;
}>();

defineEmits<{
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openRepositoryWorkspace: [target: RepositoryWorkspaceTabTarget];
  openLaunchMenu: [];
  runAction: [action: InstanceAction, instance: InstanceBoardItem];
  selectAiSession: [instanceId: string, sessionId: string];
}>();

const activeFrameUrl = computed(() => props.session ? sessionFrameUrl(props.instance, props.session) : "");
const activeTerminalSocketUrl = computed(() => props.session ? sessionTerminalSocketUrl(props.instance, props.session) : "");
const hasStatusActions = computed(() => (["start", "stop", "restart", "retry-image"] as const)
  .some((action) => canShowInstanceAction(props.instance, action)));
const imagePreparationSteps = computed(() => [
  t("instances.imagePull.checkImage"),
  t("instances.imagePull.pullLayers"),
  t("instances.imagePull.resolveDigest"),
]);
const showImagePreparation = computed(() => Boolean(
  props.instance.status !== "stopping"
  && props.instance.status !== "stopped"
  && props.instance.imageProvisioning
  && props.instance.imageProvisioning.phase !== "ready",
));
const activeImagePreparationStep = computed(() => {
  const phase = props.instance.imageProvisioning?.phase;
  if (phase === "checking-image") return 0;
  if (phase === "resolving-image") return 2;
  return 1;
});

function imagePreparationStepState(index: number) {
  if (index < activeImagePreparationStep.value) return "complete";
  if (index > activeImagePreparationStep.value) return "pending";
  return props.instance.imageProvisioning?.phase === "failed" ? "failed" : "active";
}
</script>

<style scoped>
.session-pane-content { position: relative; display: grid; min-width: 0; min-height: 0; overflow: hidden; background: var(--terminal-bg); }
.session-preview-body, .session-preview-status-page { display: grid; min-height: 0; place-items: center; align-content: center; gap: 8px; color: var(--terminal-text); padding: 28px; text-align: center; }
.session-preview-body { background: linear-gradient(var(--workspace-grid) 1px, transparent 1px), linear-gradient(90deg, var(--workspace-grid) 1px, transparent 1px), var(--workspace-bg); background-size: 40px 40px; }
.session-preview-status-page > svg, .session-status-overview > svg { color: var(--status-success); }
.session-preview-status-page[data-pending="true"] > svg, .session-preview-status-page[data-pending="true"] .session-status-overview > svg { animation: session-pane-spin 1.1s linear infinite; }
.session-preview-status-page[data-state="failed"] > svg, .session-preview-status-page[data-state="unhealthy"] > svg, .session-status-overview > .lucide-circle-alert { color: var(--status-danger); animation: none; }
.session-preview-body strong, .session-preview-status-page strong { font-size: 18px; }
.session-preview-body > span, .session-preview-status-page span { max-width: 620px; overflow-wrap: anywhere; color: var(--text-muted); font-size: 12px; }
.session-status-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
.session-status-actions button { gap: 7px; }
.session-status-actions button > span { color: inherit; }
.session-status-image-layout { display: grid; box-sizing: border-box; width: min(840px, 100%); min-height: 0; gap: 18px; text-align: left; }
.session-status-overview { display: flex; align-items: center; gap: 14px; }
.session-status-overview > div { display: grid; gap: 4px; }
.session-status-overview strong, .session-status-overview span { display: block; }
.image-preparation-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; padding: 0; list-style: none; }
.image-preparation-steps li { position: relative; display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 12px; font-weight: 700; }
.image-preparation-steps li:not(:last-child)::after { content: ""; position: absolute; z-index: 0; right: 10px; left: 34px; top: 12px; height: 1px; background: var(--line); }
.image-preparation-steps i { position: relative; z-index: 1; display: grid; width: 24px; height: 24px; place-items: center; flex: 0 0 auto; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--terminal-bg); color: inherit; font-style: normal; }
.image-preparation-steps li > span { position: relative; z-index: 1; box-sizing: border-box; max-width: none; padding-right: 12px; background: var(--terminal-bg); color: inherit; font-size: inherit; }
.image-preparation-steps li[data-state="complete"] { color: var(--status-success); }
.image-preparation-steps li[data-state="active"] { color: var(--text-strong); }
.image-preparation-steps li[data-state="complete"]:not(:last-child)::after { background: var(--status-success); }
.image-preparation-steps li[data-state="active"] i { border-color: var(--status-success); color: var(--status-success); box-shadow: 0 0 0 3px var(--brand-accent-soft); }
.image-preparation-steps li[data-state="failed"] { color: var(--status-danger); }
.session-status-image-pull { box-sizing: border-box; width: 100%; margin: 0; text-align: left; }
.session-status-image-note { padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-inset); }
.session-preview-live { position: relative; min-height: 0; overflow: hidden; background: var(--terminal-bg); }
.session-preview-frame, .session-terminal { display: block; width: 100%; height: 100%; min-height: 0; border: 0; background: var(--terminal-bg); }
.session-terminal { position: relative; box-sizing: border-box; overflow: hidden; }
.session-terminal :deep(.xterm) { box-sizing: border-box; width: 100%; height: 100%; padding: 8px; }
.session-terminal :deep(.xterm-viewport) { overflow-y: hidden; background: var(--terminal-bg) !important; }
.session-preview-launch-button { display: inline-flex; width: 112px; height: 32px; align-items: center; justify-content: center; gap: 8px; border-color: var(--terminal-selection); background: var(--surface-raised); color: var(--brand-accent-muted); font-weight: 800; }
@keyframes session-pane-spin { to { transform: rotate(360deg); } }
</style>
