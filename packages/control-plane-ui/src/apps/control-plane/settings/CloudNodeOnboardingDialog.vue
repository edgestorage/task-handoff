<template>
  <Dialog :open="open" @update:open="(value) => !value && closeDialog()">
    <DialogContent class="cloud-node-onboarding-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("settings.nodeRelay.onboardingTitle") }}</DialogTitle>
        <DialogDescription>{{ t("settings.nodeRelay.onboardingDescription") }}</DialogDescription>
      </DialogHeader>

      <ol class="cloud-node-onboarding-progress" :aria-label="t('settings.nodeRelay.onboardingProgress')">
        <li
          v-for="(item, index) in steps"
          :key="item.id"
          :aria-current="item.id === step ? 'step' : undefined"
          :class="{ active: item.id === step, complete: stepIndex > index }"
        >
          <span>{{ stepIndex > index ? "✓" : index + 1 }}</span>
          <small>{{ item.label }}</small>
        </li>
      </ol>

      <ScrollArea class="cloud-node-onboarding-scroll" :horizontal="false">
        <div class="cloud-node-onboarding-content">
          <section v-if="step === 'source'" class="cloud-node-onboarding-section">
            <h3>{{ t("settings.nodeRelay.chooseSourceTitle") }}</h3>
            <p>{{ t("settings.nodeRelay.chooseSourceHint") }}</p>

            <div v-if="!cloudRelayUsable" class="cloud-node-onboarding-unavailable" role="status">
              <Cloud :size="20" />
              <span>
                <strong>{{ cloudRelayUnavailableReason }}</strong>
                <small>{{ t("settings.nodeRelay.onboardingUnavailableHint") }}</small>
              </span>
              <Button type="button" size="sm" variant="outline" @click="emit('open-cloud-settings')">{{ t("settings.nodeRelay.openSettings") }}</Button>
            </div>

            <div v-else class="cloud-node-onboarding-choice-list" :aria-label="t('settings.nodeRelay.chooseSourceTitle')">
              <button
                type="button"
                class="cloud-node-onboarding-choice"
                :class="{ selected: source === 'existing' }"
                :aria-pressed="source === 'existing'"
                @click="source = 'existing'"
              >
                <Cloud :size="18" />
                <span>
                  <strong>{{ t("settings.nodeRelay.sourceExisting") }}</strong>
                  <small>{{ t("settings.nodeRelay.sourceExistingHint") }}</small>
                </span>
              </button>
              <button
                type="button"
                class="cloud-node-onboarding-choice"
                :class="{ selected: source === 'new' }"
                :aria-pressed="source === 'new'"
                @click="source = 'new'"
              >
                <Download :size="18" />
                <span>
                  <strong>{{ t("settings.nodeRelay.sourceNew") }}</strong>
                  <small>{{ t("settings.nodeRelay.sourceNewHint") }}</small>
                </span>
              </button>
            </div>
          </section>

          <section v-else-if="step === 'connect' && source === 'existing'" class="cloud-node-onboarding-section">
            <h3>{{ t("settings.nodeRelay.directoryTitle") }}</h3>
            <p>{{ t("settings.nodeRelay.directoryHint") }}</p>

            <div v-if="accountNodes.isLoading.value" class="cloud-node-onboarding-status" role="status">
              <LoaderCircle class="spin" :size="15" />
              <span>{{ t("settings.nodeRelay.directoryLoading") }}</span>
            </div>
            <div v-else-if="accountNodes.error.value" class="cloud-node-onboarding-error" role="alert">
              <span>{{ t("settings.nodeRelay.directoryFailed") }} {{ translateApiError(accountNodes.error.value, t) }}</span>
              <Button type="button" size="sm" variant="outline" @click="accountNodes.refetch()">{{ t("settings.nodeRelay.directoryRetry") }}</Button>
            </div>
            <ul v-else-if="accountNodeItems.length" class="cloud-node-onboarding-account-list">
              <li v-for="item in accountNodeItems" :key="item.nodeHandle" class="cloud-node-onboarding-account-item">
                <span
                  class="cloud-node-onboarding-status-dot"
                  :class="{
                    'status-online': accountNodeConnected(item.nodeHandle),
                    'status-pending': accountNodeClaimed(item.nodeHandle) && !accountNodeConnected(item.nodeHandle),
                  }"
                />
                <span class="cloud-node-onboarding-account-copy">
                  <strong>{{ item.displayName || t("settings.nodeRelay.unnamedNode") }}</strong>
                  <small>{{ accountNodeStatus(item) }} · {{ accountNodeAccess(item) }}</small>
                </span>
                <span class="cloud-node-onboarding-account-meta">
                  <Badge v-if="accountNodeConnected(item.nodeHandle)" variant="default">{{ t("settings.nodeRelay.claimed") }}</Badge>
                  <Badge v-else-if="accountNodeClaimed(item.nodeHandle)" variant="secondary">{{ t("settings.nodeRelay.waiting") }}</Badge>
                  <Button v-else type="button" size="sm" variant="outline" :disabled="Boolean(relayBusyHandle)" @click="connectAccountNode(item.nodeHandle)">
                    <LoaderCircle v-if="relayBusyHandle === item.nodeHandle" class="spin" :size="14" />
                    <span>{{ relayBusyHandle === item.nodeHandle ? t("settings.nodeRelay.connecting") : t("settings.nodeRelay.connect") }}</span>
                  </Button>
                </span>
              </li>
            </ul>
            <p v-else class="cloud-node-onboarding-instruction">{{ t("settings.nodeRelay.directoryEmpty") }}</p>
            <p v-if="relayAccountError" class="cloud-node-onboarding-error" role="alert">{{ t("settings.nodeRelay.statusError", { message: relayAccountError }) }}</p>
            <CloudNodeTrustStatus
              v-if="attempt?.source === 'existing' && attempt.nodeHandle"
              :phase="attempt.phase"
              :trust="trust"
              :display-name="attempt.displayName"
              :node-handle="attempt.nodeHandle"
              :error="cloudRelayError"
              @retry="retryOnboardingPoll"
              @cancel="cancelBindingToken"
            />
          </section>

          <section v-else-if="step === 'connect' && source === 'new'" class="cloud-node-onboarding-section">
            <h3>{{ t("settings.nodeRelay.installTitle") }}</h3>
            <p>{{ t("settings.nodeRelay.installHint") }}</p>

            <template v-if="!bindingToken">
              <label class="cloud-node-onboarding-field" for="cloud-node-onboarding-name">
                <span>{{ t("settings.nodeRelay.displayName") }}</span>
                <ControlPlaneInput id="cloud-node-onboarding-name" v-model="displayName" :maxlength="160" :placeholder="t('settings.nodeDetail.hostnameNamePlaceholder')" />
              </label>
              <Tabs v-model="commandMode">
                <TabsList class="cloud-node-onboarding-mode-tabs" :aria-label="t('settings.nodeRelay.commandMode')">
                  <TabsTrigger value="install">{{ t("settings.nodeRelay.installMode") }}</TabsTrigger>
                  <TabsTrigger value="bind">{{ t("settings.nodeRelay.bindMode") }}</TabsTrigger>
                </TabsList>
              </Tabs>
              <p class="cloud-node-onboarding-instruction">{{ t(commandMode === "install" ? "settings.nodeRelay.installModeHint" : "settings.nodeRelay.bindModeHint") }}</p>
            </template>

            <template v-else>
              <div class="cloud-node-onboarding-command-card">
                <div class="cloud-node-onboarding-command-head">
                  <div class="cloud-node-onboarding-command-title">
                    <span>{{ t(commandMode === "install" ? "settings.nodeRelay.installCommand" : "settings.nodeRelay.bindCommand") }}</span>
                    <small><KeyRound :size="13" aria-hidden="true" />{{ t("settings.nodeRelay.commandOnce") }}</small>
                  </div>
                  <Button type="button" size="sm" variant="outline" :disabled="bindingTokenExpired" @click="copyCommand">
                    <Check v-if="copied" :size="14" /><Copy v-else :size="14" />
                    <span>{{ copied ? t("settings.nodeRelay.copied") : t("settings.nodeRelay.copy") }}</span>
                  </Button>
                </div>
                <NodeAgentInstallerSourceToggle v-if="commandMode === 'install'" v-model="installerSource" />
                <ScrollArea class="cloud-node-onboarding-command-code">
                  <pre tabindex="0"><code>{{ generatedCommand }}</code></pre>
                </ScrollArea>
                <div class="cloud-node-onboarding-command-footer">
                  <div class="cloud-node-onboarding-status" :class="{ expired: bindingTokenExpired }" role="status">
                    <Clock3 :size="15" />
                    <span>{{ bindingTokenExpired ? t("settings.nodeRelay.expired") : t("settings.nodeRelay.expiresIn", { time: formattedExpiry }) }}</span>
                  </div>
                  <Button type="button" size="sm" variant="ghost" class="cloud-node-onboarding-command-cancel" :disabled="busy" @click="cancelBindingToken">{{ t("settings.nodeRelay.cancelToken") }}</Button>
                </div>
              </div>
              <div v-if="cloudRelayWaitingForNode" class="cloud-node-onboarding-waiting" role="status">
                <LoaderCircle class="spin" :size="15" />
                <span>{{ t("settings.nodeRelay.waitingForInstall") }}</span>
              </div>
              <CloudNodeTrustStatus
                v-if="attempt"
                :phase="attempt.phase"
                :trust="trust"
                :display-name="attempt.displayName"
                :node-handle="attempt.nodeHandle"
                :error="cloudRelayError"
                @retry="retryOnboardingPoll"
                @cancel="cancelBindingToken"
              />
            </template>
          </section>

          <section v-else-if="step === 'complete'" class="cloud-node-onboarding-complete" role="status">
            <CircleCheck :size="34" />
            <h3>{{ t("settings.nodeOnboarding.complete.title") }}</h3>
            <p>{{ t("settings.nodeOnboarding.complete.description", { name: completedNode?.name || completedNode?.id || "" }) }}</p>
          </section>
        </div>
      </ScrollArea>

      <DialogFooter class="cloud-node-onboarding-footer">
        <Button v-if="step === 'source'" type="button" variant="outline" @click="closeDialog">{{ t("common.actions.cancel") }}</Button>
        <Button v-else-if="step === 'connect'" type="button" variant="outline" :disabled="busy" @click="goBack">
          <ArrowLeft :size="14" /><span>{{ t("common.actions.back") }}</span>
        </Button>
        <Button v-if="step === 'source'" type="button" :disabled="!source || !cloudRelayUsable" @click="step = 'connect'">{{ t("common.actions.continue") }}</Button>
        <Button v-else-if="step === 'connect' && source === 'new'" type="button" :disabled="busy" @click="generateBindingToken">
          <LoaderCircle v-if="busy" class="spin" :size="14" /><Download v-else :size="14" />
          <span>{{ bindingToken ? t("settings.nodeRelay.regenerate") : t("settings.nodeRelay.generate") }}</span>
        </Button>
        <Button v-else-if="step === 'complete'" type="button" @click="closeDialog">{{ t("common.actions.done") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, Check, CircleCheck, Clock3, Cloud, Copy, Download, KeyRound, LoaderCircle } from "@lucide/vue";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import {
  cancelCloudNodeBindingToken,
  claimCloudAccountNode,
  controlPlaneQueryKeys,
  createCloudNodeBindingToken,
  releaseCloudAccountNodeClaim,
  useCloudAccountNodesQuery,
  useCloudAccountQuery,
  useCloudConnectivityQuery,
} from "../../../api/queries";
import type { CloudAccountNode, Node } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import CloudNodeTrustStatus from "./CloudNodeTrustStatus.vue";
import { withNodeAgentInstallerSource } from "./nodeAgentInstallCommand";
import NodeAgentInstallerSourceToggle from "./NodeAgentInstallerSourceToggle.vue";
import {
  beginCloudNodeOnboarding,
  completeCloudNodeOnboarding,
  failCloudNodeOnboarding,
  resetCloudNodeOnboarding,
  resumeCloudNodeOnboarding,
  setCloudNodeOnboardingNodeHandle,
  setCloudNodeOnboardingToken,
  syncCloudNodeOnboarding,
  useCloudNodeOnboardingAttempt,
} from "./cloudNodeOnboardingAttempt";
import { DEFAULT_NODE_AGENT_INSTALLER_SOURCE, type NodeAgentInstallerSource } from "@task-handoff/protocol/control-plane";

type Step = "source" | "connect" | "complete";
type NodeSource = "existing" | "new";
type CommandMode = "install" | "bind";

const props = defineProps<{
  open: boolean;
  nodes: Node[];
  controlPlaneUrl: string;
}>();
const emit = defineEmits<{ close: []; created: [node: Node]; "open-cloud-settings": [] }>();
const { t } = useI18n();
const { locale } = useControlPlaneLocale();
const queryClient = useQueryClient();
const step = ref<Step>("source");
const source = ref<NodeSource>();
const commandMode = ref<CommandMode>("install");
const installerSource = ref<NodeAgentInstallerSource>(DEFAULT_NODE_AGENT_INSTALLER_SOURCE);
const displayNameDraft = ref("");
const copied = ref(false);
const busy = ref(false);
const relayBusyHandle = ref("");
const nowMs = ref(Date.now());
const onboarding = useCloudNodeOnboardingAttempt();
const attempt = onboarding.attempt;
const displayName = computed({
  get: () => attempt.value?.displayName ?? displayNameDraft.value,
  set: (value: string) => { displayNameDraft.value = value; },
});
const bindingToken = computed(() => attempt.value?.token);
const completedNode = computed(() => attempt.value?.nodeId ? props.nodes.find((node) => node.id === attempt.value?.nodeId) : undefined);
const cloudRelayError = computed(() => attempt.value?.error || "");
const trust = computed(() => attempt.value?.trust);
const account = useCloudAccountQuery();
const connectivity = useCloudConnectivityQuery();
const cloudRelaySignedIn = computed(() => Boolean(account.data.value?.signedIn));
const cloudRelayBound = computed(() => connectivity.data.value?.status === "active");
const cloudRelayScopeEnabled = computed(() => connectivity.data.value?.scopes?.nodeRelay === true);
const cloudRelayUsable = computed(() => cloudRelaySignedIn.value && cloudRelayBound.value && cloudRelayScopeEnabled.value);
const accountNodes = useCloudAccountNodesQuery({
  enabled: () => cloudRelayUsable.value && (props.open || onboarding.active.value),
  refetchIntervalMs: () => onboarding.active.value ? 2_000 : false,
});
let clock: ReturnType<typeof setInterval> | undefined;

const steps = computed(() => [
  { id: "source" as const, label: t("settings.nodeRelay.onboardingSteps.source") },
  { id: "connect" as const, label: t("settings.nodeRelay.onboardingSteps.connect") },
  { id: "complete" as const, label: t("settings.nodeRelay.onboardingSteps.complete") },
]);
const stepIndex = computed(() => steps.value.findIndex((item) => item.id === step.value));
const cloudRelayUnavailableReason = computed(() => !cloudRelaySignedIn.value
  ? t("settings.nodeRelay.unavailableSignedIn")
  : !cloudRelayBound.value ? t("settings.nodeRelay.unavailableUnbound") : t("settings.nodeRelay.unavailableScope"));
const accountNodeItems = computed(() => (accountNodes.data.value?.items ?? []).filter((item) => item.status === "active"));
const accountNodeConnected = (nodeHandle: string) => Boolean(accountNodes.data.value?.nodeRelay.channels.some((channel) => channel.nodeHandle === nodeHandle && channel.connected));
const accountNodeClaimed = (nodeHandle: string) => attempt.value?.nodeHandle === nodeHandle || Boolean(accountNodes.data.value?.nodeRelay.claims.some((claim) => claim.nodeHandle === nodeHandle)) || accountNodeConnected(nodeHandle);
const accountNodeStatus = (item: CloudAccountNode) => t(`settings.nodeRelay.accountStatus.${item.status}`);
const accountNodeAccess = (item: CloudAccountNode) => item.access?.kind === 'shared'
  ? t("settings.nodeRelay.accountAccessShared", { expiresAt: formatDateTime(new Date(item.access.expiresAt), locale.value) })
  : t("settings.nodeRelay.accountAccessOwner");
const relayAccountError = computed(() => accountNodes.data.value?.nodeRelay.errors[0]?.message || "");
const generatedCommand = computed(() => {
  if (commandMode.value === "bind") return bindingToken.value?.command ?? "";
  const command = bindingToken.value?.installCommand ?? "";
  return command
    ? withNodeAgentInstallerSource(command, { controlPlaneUrl: props.controlPlaneUrl, installerSource: installerSource.value })
    : "";
});
const bindingTokenExpired = computed(() => Boolean(bindingToken.value && Date.parse(bindingToken.value.expiresAt) <= nowMs.value));
const cloudRelayWaitingForNode = computed(() => {
  if (!bindingToken.value || bindingTokenExpired.value) return false;
  const consumed = accountNodes.data.value?.nodeRelay.onboarding.some((item) => item.tokenId === bindingToken.value?.tokenId) ?? false;
  return !consumed;
});
const formattedExpiry = computed(() => bindingToken.value ? formatDateTime(new Date(bindingToken.value.expiresAt), locale.value) : "");

watch(() => props.open, (open) => {
  if (!open) {
    stopClock();
    return;
  }
  if (attempt.value) restoreAttemptView();
  else resetView();
  void account.refetch();
  void connectivity.refetch();
  clock = setInterval(() => { nowMs.value = Date.now(); }, 1_000);
});

watch(() => accountNodes.data.value, (data) => {
  syncCloudNodeOnboarding(data);
  applyOnboardingState();
});

watch(() => accountNodes.error.value, (error) => {
  if (error && onboarding.active.value) {
    failCloudNodeOnboarding(translateApiError(error, t));
    applyOnboardingState();
  }
});

watch(installerSource, () => {
  copied.value = false;
});

watch(() => props.nodes, applyOnboardingState, { deep: false });

onBeforeUnmount(stopClock);

function resetView() {
  stopClock();
  step.value = "source";
  source.value = undefined;
  commandMode.value = "install";
  installerSource.value = DEFAULT_NODE_AGENT_INSTALLER_SOURCE;
  displayNameDraft.value = "";
  copied.value = false;
  busy.value = false;
  relayBusyHandle.value = "";
  nowMs.value = Date.now();
}

function restoreAttemptView() {
  if (!attempt.value) return;
  source.value = attempt.value.source;
  displayNameDraft.value = attempt.value.displayName;
  step.value = attempt.value.phase === "complete" ? "complete" : "connect";
  if (attempt.value.phase === "complete") applyOnboardingState();
}

function stopClock() {
  if (clock) clearInterval(clock);
  clock = undefined;
}

async function connectAccountNode(nodeHandle: string) {
  if (relayBusyHandle.value) return;
  relayBusyHandle.value = nodeHandle;
  beginCloudNodeOnboarding("existing");
  setCloudNodeOnboardingNodeHandle(nodeHandle);
  try {
    await claimCloudAccountNode(nodeHandle);
    await accountNodes.refetch();
    syncCloudNodeOnboarding(accountNodes.data.value);
    applyOnboardingState();
  } catch (error) {
    failCloudNodeOnboarding(translateApiError(error, t));
  } finally {
    relayBusyHandle.value = "";
  }
}

async function generateBindingToken() {
  if (busy.value) return;
  busy.value = true;
  beginCloudNodeOnboarding("new", displayName.value.trim());
  try {
    if (bindingToken.value) await cancelCloudNodeBindingToken(bindingToken.value.tokenId).catch(() => undefined);
    setCloudNodeOnboardingToken(await createCloudNodeBindingToken(displayName.value.trim() ? { displayName: displayName.value.trim() } : {}));
    copied.value = false;
  } catch (error) {
    failCloudNodeOnboarding(translateApiError(error, t));
  } finally {
    busy.value = false;
  }
}

async function cancelBindingToken() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (bindingToken.value) await cancelCloudNodeBindingToken(bindingToken.value.tokenId);
    else if (attempt.value?.source === "existing" && attempt.value.nodeHandle) await releaseCloudAccountNodeClaim(attempt.value.nodeHandle);
    resetCloudNodeOnboarding();
    resetView();
    void accountNodes.refetch();
    copied.value = false;
  } catch (error) {
    failCloudNodeOnboarding(translateApiError(error, t));
  } finally {
    busy.value = false;
  }
}

async function copyCommand() {
  if (!generatedCommand.value || !navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(generatedCommand.value);
    copied.value = true;
  } catch {
    failCloudNodeOnboarding(t("settings.nodeRelay.clipboardFailed"));
  }
}

let completedAttemptId = 0;

function applyOnboardingState() {
  if (!attempt.value) return;
  if (attempt.value.phase === "complete") {
    const node = props.nodes.find((item) => item.id === attempt.value?.nodeId);
    if (node && completedAttemptId !== attempt.value.id) {
      completedAttemptId = attempt.value.id;
      completeCloudNodeOnboarding(node);
      void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes });
      step.value = "complete";
      copied.value = false;
      emit("created", node);
    }
  }
}

function goBack() {
  step.value = "source";
}

function closeDialog() {
  stopClock();
  if (attempt.value?.phase === "complete") resetCloudNodeOnboarding();
  emit("close");
}

function retryOnboardingPoll() {
  resumeCloudNodeOnboarding();
  void accountNodes.refetch();
}
</script>

<style scoped>
:global(.cloud-node-onboarding-dialog) {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: min(680px, calc(100vw - 32px));
  max-width: 680px;
  max-height: min(720px, calc(100dvh - 32px));
  overflow: hidden;
}

.cloud-node-onboarding-progress {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 2px 0 4px;
  padding: 0 24px;
  list-style: none;
}

.cloud-node-onboarding-progress li {
  position: relative;
  display: grid;
  grid-template-rows: 28px auto;
  justify-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
}

.cloud-node-onboarding-progress li:not(:last-child)::after {
  position: absolute;
  top: 13px;
  left: calc(50% + 18px);
  z-index: 0;
  width: calc(100% - 36px);
  height: 2px;
  border-radius: 2px;
  background: var(--line-strong);
  content: "";
}

.cloud-node-onboarding-progress li.complete::after {
  background: hsl(var(--primary));
}

.cloud-node-onboarding-progress li > span {
  position: relative;
  z-index: 1;
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface);
  font-size: 12px;
  line-height: 1;
}

.cloud-node-onboarding-progress li small {
  width: 100%;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-node-onboarding-progress li.active,
.cloud-node-onboarding-progress li.complete {
  color: var(--text-strong);
}

.cloud-node-onboarding-progress li.active > span,
.cloud-node-onboarding-progress li.complete > span {
  border-color: hsl(var(--primary));
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.cloud-node-onboarding-progress li.active > span {
  box-shadow: 0 0 0 4px hsl(var(--primary) / 0.16);
}

.cloud-node-onboarding-scroll {
  min-height: 0;
}

.cloud-node-onboarding-content,
.cloud-node-onboarding-section {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.cloud-node-onboarding-content {
  padding: 2px 14px 2px 0;
}

.cloud-node-onboarding-section h3,
.cloud-node-onboarding-complete h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
}

.cloud-node-onboarding-section > p,
.cloud-node-onboarding-complete p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.cloud-node-onboarding-choice-list {
  display: grid;
  gap: 8px;
}

.cloud-node-onboarding-choice {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 58px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.cloud-node-onboarding-choice:hover {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
}

.cloud-node-onboarding-choice.selected {
  border-color: var(--brand-accent);
  background: var(--surface-active);
}

.cloud-node-onboarding-choice.selected > svg {
  color: var(--brand-accent);
}

.cloud-node-onboarding-choice > span,
.cloud-node-onboarding-unavailable > span,
.cloud-node-onboarding-account-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.cloud-node-onboarding-choice strong,
.cloud-node-onboarding-unavailable strong,
.cloud-node-onboarding-account-copy strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.cloud-node-onboarding-choice small,
.cloud-node-onboarding-unavailable small,
.cloud-node-onboarding-account-copy small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
}

.cloud-node-onboarding-unavailable {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
  padding: 12px;
}

.cloud-node-onboarding-account-list {
  display: grid;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
  list-style: none;
}

.cloud-node-onboarding-account-item {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 10px 12px;
}

.cloud-node-onboarding-account-item + .cloud-node-onboarding-account-item {
  border-top: 1px solid var(--line);
}

.cloud-node-onboarding-account-copy strong,
.cloud-node-onboarding-account-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-node-onboarding-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--text-subtle);
  box-shadow: 0 0 0 3px var(--surface-subtle);
}

.cloud-node-onboarding-status-dot.status-online {
  background: var(--status-success);
  box-shadow: 0 0 0 3px var(--brand-accent-soft);
}

.cloud-node-onboarding-status-dot.status-pending {
  background: var(--status-warning);
  box-shadow: 0 0 0 3px var(--status-warning-bg);
}

.cloud-node-onboarding-account-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cloud-node-onboarding-field {
  display: grid;
  gap: 6px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 400;
}

.cloud-node-onboarding-mode-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  height: 32px;
  min-height: 32px;
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
}

.cloud-node-onboarding-mode-tabs :deep(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  min-height: 26px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  padding: 0 10px;
  white-space: nowrap;
  cursor: pointer;
}

.cloud-node-onboarding-mode-tabs :deep(button:hover),
.cloud-node-onboarding-mode-tabs :deep(button:focus-visible),
.cloud-node-onboarding-mode-tabs :deep(button[data-state="active"]) {
  background: var(--surface-active);
  color: var(--text-strong);
  box-shadow: none;
  outline: none;
}

.cloud-node-onboarding-status,
.cloud-node-onboarding-instruction {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.cloud-node-onboarding-status.expired {
  color: var(--status-warning);
}

.cloud-node-onboarding-command-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.cloud-node-onboarding-command-card {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-raised);
}

.cloud-node-onboarding-command-title {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.cloud-node-onboarding-command-title > span {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.cloud-node-onboarding-command-title small {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
}

.cloud-node-onboarding-command-title small > svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--brand-accent);
}

.cloud-node-onboarding-command-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.cloud-node-onboarding-command-cancel {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.cloud-node-onboarding-command-cancel:hover {
  background: var(--status-danger-bg);
  color: var(--status-danger);
}

.cloud-node-onboarding-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.cloud-node-onboarding-waiting > svg {
  flex: 0 0 auto;
  color: var(--brand-accent);
}

.cloud-node-onboarding-command-code {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-inset);
}

.cloud-node-onboarding-command-code :deep(pre) {
  width: max-content;
  min-width: 100%;
  margin: 0;
  padding: 12px 12px 18px;
  overflow: visible;
  color: var(--text);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre;
}

.cloud-node-onboarding-error {
  margin: 0;
  color: var(--status-danger);
  font-size: 12px;
  line-height: 1.45;
}

.cloud-node-onboarding-complete {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 36px 12px;
  text-align: center;
}

.cloud-node-onboarding-complete > svg {
  color: var(--status-success);
}

.cloud-node-onboarding-footer {
  flex-wrap: nowrap;
}

.spin { animation: cloud-node-onboarding-spin 0.9s linear infinite; }
@keyframes cloud-node-onboarding-spin { to { transform: rotate(360deg); } }

@media (max-width: 560px) {
  :global(.cloud-node-onboarding-dialog) {
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 20px);
  }

  .cloud-node-onboarding-progress {
    padding: 0 12px;
  }

  .cloud-node-onboarding-unavailable {
    grid-template-columns: 22px minmax(0, 1fr);
  }

  .cloud-node-onboarding-unavailable > button {
    grid-column: 2;
    justify-self: start;
  }

  .cloud-node-onboarding-command-head {
    align-items: stretch;
    flex-direction: column;
  }

  .cloud-node-onboarding-command-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
