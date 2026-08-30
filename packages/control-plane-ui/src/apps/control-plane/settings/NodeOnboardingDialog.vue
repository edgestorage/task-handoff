<template>
  <Dialog :open="open" @update:open="(value) => !value && closeDialog()">
    <DialogContent class="node-onboarding-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("settings.nodeOnboarding.title") }}</DialogTitle>
        <DialogDescription>{{ t("settings.nodeOnboarding.description") }}</DialogDescription>
      </DialogHeader>

      <ol class="node-onboarding-progress" :aria-label="t('settings.nodeOnboarding.progress')">
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

      <ScrollArea class="node-onboarding-scroll" :horizontal="false">
        <div class="node-onboarding-content">
          <section v-if="step === 'network'" class="node-onboarding-section">
            <div class="node-onboarding-heading">
              <div>
                <h3>{{ t("settings.nodeOnboarding.network.title") }}</h3>
                <p>{{ t("settings.nodeOnboarding.network.description") }}</p>
              </div>
              <Button type="button" size="sm" variant="outline" :disabled="decision.probe.status === 'checking'" @click="runProbe">
                <RefreshCw :class="{ spin: decision.probe.status === 'checking' }" :size="14" />
                <span>{{ t("settings.nodeOnboarding.network.recheck") }}</span>
              </Button>
            </div>

            <label class="node-onboarding-field" for="node-onboarding-origin">
              <span>{{ t("settings.nodeOnboarding.network.origin") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example control-plane URL -->
              <ControlPlaneInput id="node-onboarding-origin" v-model="controlPlaneOrigin" placeholder="https://control-plane.example.com" @change="runProbe" />
            </label>

            <div class="node-onboarding-probe" :data-status="decision.probe.status" role="status">
              <LoaderCircle v-if="decision.probe.status === 'checking'" class="spin" :size="15" />
              <CircleCheck v-else-if="decision.probe.status === 'reachable'" :size="15" />
              <CircleAlert v-else :size="15" />
              <span>{{ probeLabel }}</span>
            </div>

            <div class="node-onboarding-choice-list" :aria-label="t('settings.nodeOnboarding.network.question')">
              <button
                type="button"
                class="node-onboarding-choice"
                :aria-pressed="decision.selection.value === 'publicly-reachable'"
                :class="{ selected: decision.selection.value === 'publicly-reachable' }"
                @click="chooseControlPlaneReachability('publicly-reachable')"
              >
                <Globe2 :size="18" aria-hidden="true" />
                <span><strong>{{ t("settings.nodeOnboarding.network.public") }}</strong><small>{{ t("settings.nodeOnboarding.network.publicDescription") }}</small></span>
                <Badge v-if="recommendedReachability === 'publicly-reachable'" class="node-onboarding-badge" variant="secondary">{{ t("settings.nodeOnboarding.recommended") }}</Badge>
              </button>
              <button
                type="button"
                class="node-onboarding-choice"
                :aria-pressed="decision.selection.value === 'not-publicly-reachable'"
                :class="{ selected: decision.selection.value === 'not-publicly-reachable' }"
                @click="chooseControlPlaneReachability('not-publicly-reachable')"
              >
                <Network :size="18" aria-hidden="true" />
                <span><strong>{{ t("settings.nodeOnboarding.network.private") }}</strong><small>{{ t("settings.nodeOnboarding.network.privateDescription") }}</small></span>
                <Badge v-if="recommendedReachability === 'not-publicly-reachable'" class="node-onboarding-badge" variant="secondary">{{ t("settings.nodeOnboarding.recommended") }}</Badge>
              </button>
            </div>
            <p v-if="reachabilityConflict(decision)" class="node-onboarding-warning" role="status">
              <TriangleAlert :size="15" />
              {{ t("settings.nodeOnboarding.network.overrideWarning") }}
            </p>
          </section>

          <section v-else-if="step === 'target'" class="node-onboarding-section">
            <template v-if="controlPlanePublic">
              <h3>{{ t("settings.nodeOnboarding.target.agentInstalledTitle") }}</h3>
              <p>{{ t("settings.nodeOnboarding.target.agentInstalledDescription") }}</p>
              <div class="node-onboarding-choice-list" :aria-label="t('settings.nodeOnboarding.target.agentInstalledTitle')">
                <button type="button" class="node-onboarding-choice" :class="{ selected: agentInstalled === true }" :aria-pressed="agentInstalled === true" @click="agentInstalled = true">
                  <ServerCog :size="18" /><span><strong>{{ t("settings.nodeOnboarding.target.installed") }}</strong><small>{{ t("settings.nodeOnboarding.target.installedDescription") }}</small></span>
                </button>
                <button type="button" class="node-onboarding-choice" :class="{ selected: agentInstalled === false }" :aria-pressed="agentInstalled === false" @click="agentInstalled = false">
                  <Download :size="18" /><span><strong>{{ t("settings.nodeOnboarding.target.notInstalled") }}</strong><small>{{ t("settings.nodeOnboarding.target.notInstalledDescription") }}</small></span>
                </button>
              </div>
              <label class="node-onboarding-field" for="node-onboarding-join-name">
                <span>{{ t("settings.nodeOnboarding.target.optionalName") }}</span>
                <ControlPlaneInput id="node-onboarding-join-name" v-model="nodeName" :maxlength="160" />
              </label>
            </template>

            <template v-else>
              <h3>{{ t("settings.nodeOnboarding.target.agentPublicTitle") }}</h3>
              <p>{{ t("settings.nodeOnboarding.target.agentPublicDescription") }}</p>
              <div class="node-onboarding-choice-list" :aria-label="t('settings.nodeOnboarding.target.agentPublicTitle')">
                <button type="button" class="node-onboarding-choice" :class="{ selected: nodeAgentPublic === true }" :aria-pressed="nodeAgentPublic === true" @click="nodeAgentPublic = true">
                  <Globe2 :size="18" /><span><strong>{{ t("settings.nodeOnboarding.target.agentPublic") }}</strong><small>{{ t("settings.nodeOnboarding.target.agentPublicHint") }}</small></span>
                </button>
                <button type="button" class="node-onboarding-choice" :class="{ selected: nodeAgentPublic === false }" :aria-pressed="nodeAgentPublic === false" @click="nodeAgentPublic = false">
                  <Cloud :size="18" /><span><strong>{{ t("settings.nodeOnboarding.target.neitherPublic") }}</strong><small>{{ t("settings.nodeOnboarding.target.neitherPublicHint") }}</small></span>
                </button>
              </div>
            </template>
          </section>

          <section v-else-if="step === 'connect' && connectionPath === 'reverse'" class="node-onboarding-section">
            <h3>{{ t(agentInstalled ? "settings.nodeOnboarding.reverse.connectTitle" : "settings.nodeOnboarding.reverse.installTitle") }}</h3>
            <p>{{ t(agentInstalled ? "settings.nodeOnboarding.reverse.connectDescription" : "settings.nodeOnboarding.reverse.installDescription") }}</p>
            <div v-if="agentInstalled" class="node-onboarding-source-switch" :aria-label="t('settings.nodeOnboarding.reverse.method')">
              <button type="button" :class="{ active: reverseConnectionMethod === 'ui' }" :aria-pressed="reverseConnectionMethod === 'ui'" @click="chooseReverseMethod('ui')">{{ t("settings.nodeOnboarding.reverse.useUi") }}</button>
              <button type="button" :class="{ active: reverseConnectionMethod === 'command' }" :aria-pressed="reverseConnectionMethod === 'command'" @click="chooseReverseMethod('command')">{{ t("settings.nodeOnboarding.reverse.useCommand") }}</button>
            </div>
            <div v-if="agentInstalled && reverseConnectionMethod === 'ui'" class="node-onboarding-ui-connect">
              <ol>
                <li>{{ t("settings.nodeOnboarding.reverse.uiStepOpen") }}</li>
                <li>{{ t("settings.nodeOnboarding.reverse.uiStepAdd") }}</li>
                <li>{{ t("settings.nodeOnboarding.reverse.uiStepSubmit") }}</li>
              </ol>
              <div class="node-onboarding-copy-field">
                <span>{{ t("settings.nodeOnboarding.reverse.controlPlaneUrl") }}</span>
                <code>{{ controlPlaneOrigin }}</code>
                <Button type="button" size="sm" variant="outline" :disabled="inviteExpired" @click="copyReverseValue('url')">
                  <Check v-if="copiedReverseValue === 'url'" :size="14" /><Copy v-else :size="14" />
                  <span>{{ copiedReverseValue === 'url' ? t("settings.nodeOnboarding.copied") : t("settings.nodeOnboarding.reverse.copyUrl") }}</span>
                </Button>
              </div>
              <div class="node-onboarding-copy-field">
                <span>{{ t("settings.nodeOnboarding.reverse.joinToken") }}</span>
                <code>{{ joinInvite?.joinToken }}</code>
                <Button type="button" size="sm" variant="outline" :disabled="inviteExpired || !joinInvite" @click="copyReverseValue('token')">
                  <Check v-if="copiedReverseValue === 'token'" :size="14" /><Copy v-else :size="14" />
                  <span>{{ copiedReverseValue === 'token' ? t("settings.nodeOnboarding.copied") : t("settings.nodeOnboarding.reverse.copyToken") }}</span>
                </Button>
              </div>
            </div>
            <template v-else>
              <div class="node-onboarding-command-head">
                <span>{{ t("settings.nodeOnboarding.reverse.runCommand") }}</span>
                <Button type="button" size="sm" variant="outline" :disabled="inviteExpired || !installCommand" @click="copyReverseValue('command')">
                  <Check v-if="copiedReverseValue === 'command'" :size="14" /><Copy v-else :size="14" />
                  <span>{{ copiedReverseValue === 'command' ? t("settings.nodeOnboarding.copied") : t("settings.nodeOnboarding.copy") }}</span>
                </Button>
              </div>
              <pre><code>{{ installCommand }}</code></pre>
            </template>
            <div class="node-onboarding-waiting" :class="{ expired: inviteExpired }" role="status">
              <Clock3 v-if="inviteExpired" :size="16" />
              <LoaderCircle v-else class="spin" :size="16" />
              <span>{{ inviteExpired ? t("settings.nodeOnboarding.reverse.expired") : t("settings.nodeOnboarding.reverse.waiting", { time: formattedExpiry }) }}</span>
            </div>
          </section>

          <section v-else-if="step === 'connect' && connectionPath === 'direct'" class="node-onboarding-section">
            <h3>{{ t("settings.nodeOnboarding.direct.title") }}</h3>
            <p>{{ t("settings.nodeOnboarding.direct.description") }}</p>
            <label class="node-onboarding-field" for="node-onboarding-endpoint">
              <span>{{ t("settings.nodeOnboarding.direct.endpoint") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example node-agent URL -->
              <ControlPlaneInput id="node-onboarding-endpoint" v-model="directDraft.endpoint" :aria-invalid="directErrorField === 'endpoint'" aria-describedby="node-onboarding-direct-error" placeholder="https://node.example.com" />
            </label>
            <div class="node-onboarding-source-switch" :aria-label="t('settings.nodeOnboarding.direct.tokenSource')">
              <button type="button" :class="{ active: tokenSource === 'managed' }" :aria-pressed="tokenSource === 'managed'" @click="tokenSource = 'managed'">{{ t("settings.nodeOnboarding.direct.managed") }}</button>
              <button type="button" :class="{ active: tokenSource === 'standalone' }" :aria-pressed="tokenSource === 'standalone'" @click="tokenSource = 'standalone'">{{ t("settings.nodeOnboarding.direct.standalone") }}</button>
            </div>
            <p class="node-onboarding-instruction">{{ t(tokenSource === "managed" ? "settings.nodeOnboarding.direct.managedHelp" : "settings.nodeOnboarding.direct.standaloneHelp") }}</p>
            <!-- i18n-audit-allow-next-line code-token: executable CLI command -->
            <pre v-if="tokenSource === 'standalone'" class="node-onboarding-short-command"><code>sudo task-handoff-node-agent invite</code></pre>
            <label class="node-onboarding-field" for="node-onboarding-token">
              <span>{{ t("settings.nodeOnboarding.direct.token") }}</span>
              <ControlPlaneInput id="node-onboarding-token" v-model="directDraft.joinToken" :aria-invalid="directErrorField === 'token'" aria-describedby="node-onboarding-direct-error" autocomplete="off" type="password" />
            </label>
            <label class="node-onboarding-field" for="node-onboarding-direct-name">
              <span>{{ t("settings.nodeOnboarding.target.optionalName") }}</span>
              <ControlPlaneInput id="node-onboarding-direct-name" v-model="directDraft.name" :maxlength="160" />
            </label>
            <p v-if="operationError" id="node-onboarding-direct-error" class="node-onboarding-error" role="alert">{{ operationError }}</p>
          </section>

          <section v-else-if="step === 'connect' && connectionPath === 'proxy'" class="node-onboarding-section">
            <h3>{{ t("settings.nodeOnboarding.relay.title") }}</h3>
            <p>{{ t("settings.nodeOnboarding.relay.description") }}</p>
            <div class="node-onboarding-relay-option disabled" aria-disabled="true">
              <Cloud :size="18" /><span><strong>{{ t("settings.nodeOnboarding.relay.account") }}</strong><small>{{ t("settings.nodeOnboarding.relay.accountUnavailable") }}</small></span>
              <Badge class="node-onboarding-badge" variant="secondary">{{ t("settings.nodeOnboarding.unavailable") }}</Badge>
            </div>
            <div class="node-onboarding-relay-option selected">
              <Server :size="18" /><span><strong>{{ t("settings.nodeOnboarding.relay.proxy") }}</strong><small>{{ t("settings.nodeOnboarding.relay.proxyDescription") }}</small></span>
            </div>
            <label class="node-onboarding-field" for="node-onboarding-proxy-origin">
              <span>{{ t("settings.controlPlaneProxy.proxyOrigin") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example trusted control-plane origin -->
              <ControlPlaneInput id="node-onboarding-proxy-origin" v-model="proxyDraft.proxyOrigin" :aria-invalid="proxyErrorField === 'origin'" aria-describedby="node-onboarding-proxy-error" placeholder="https://control-plane.example.com" />
            </label>
            <label class="node-onboarding-field" for="node-onboarding-proxy-token">
              <span>{{ t("settings.controlPlaneProxy.inviteToken") }}</span>
              <ControlPlaneInput id="node-onboarding-proxy-token" v-model="proxyDraft.inviteToken" :aria-invalid="proxyErrorField === 'token'" aria-describedby="node-onboarding-proxy-error" autocomplete="off" type="password" />
            </label>
            <label class="node-onboarding-field" for="node-onboarding-proxy-name">
              <span>{{ t("settings.nodeOnboarding.target.optionalName") }}</span>
              <ControlPlaneInput id="node-onboarding-proxy-name" v-model="proxyDraft.name" :maxlength="160" />
            </label>
            <label class="node-onboarding-trust">
              <Checkbox :model-value="proxyDraft.trusted" :aria-invalid="proxyErrorField === 'trust'" aria-describedby="node-onboarding-proxy-error" @update:model-value="(value) => proxyDraft.trusted = value === true" />
              <span>{{ t("settings.controlPlaneProxy.trustConfirmation") }}</span>
            </label>
            <p v-if="operationError" id="node-onboarding-proxy-error" class="node-onboarding-error" role="alert">{{ operationError }}</p>
          </section>

          <section v-else-if="step === 'complete'" class="node-onboarding-complete" role="status">
            <CircleCheck :size="34" />
            <h3>{{ t("settings.nodeOnboarding.complete.title") }}</h3>
            <p>{{ t("settings.nodeOnboarding.complete.description", { name: completedNode?.name || completedNode?.id || "" }) }}</p>
          </section>

          <p v-if="operationError && connectionPath === 'reverse'" class="node-onboarding-error" role="alert">{{ operationError }}</p>
        </div>
      </ScrollArea>

      <DialogFooter class="node-onboarding-footer">
        <Button v-if="step === 'network'" type="button" variant="outline" @click="closeDialog">{{ t("common.actions.cancel") }}</Button>
        <Button v-else-if="step !== 'complete'" type="button" variant="outline" :disabled="busy" @click="goBack">
          <ArrowLeft :size="14" /><span>{{ t("common.actions.back") }}</span>
        </Button>
        <Button v-if="step === 'network'" type="button" @click="step = 'target'">{{ t("common.actions.continue") }}</Button>
        <Button v-else-if="step === 'target'" type="button" :disabled="!canContinueTarget || busy" @click="prepareConnection">
          <LoaderCircle v-if="busy" class="spin" :size="14" />
          <span>{{ t(controlPlanePublic ? "settings.nodeOnboarding.prepare" : "common.actions.continue") }}</span>
        </Button>
        <Button v-else-if="step === 'connect' && connectionPath === 'reverse'" type="button" :disabled="busy" @click="regenerateInvite">
          <RefreshCw :size="14" /><span>{{ t("settings.nodeOnboarding.reverse.regenerate") }}</span>
        </Button>
        <Button v-else-if="step === 'connect' && connectionPath === 'direct'" type="button" :disabled="busy" @click="submitDirect">
          <LoaderCircle v-if="busy" class="spin" :size="14" /><Link2 v-else :size="14" />
          <span>{{ t(busy ? "settings.nodeOnboarding.connecting" : "settings.nodeOnboarding.connect") }}</span>
        </Button>
        <Button v-else-if="step === 'connect' && connectionPath === 'proxy'" type="button" :disabled="busy" @click="submitProxy">
          <LoaderCircle v-if="busy" class="spin" :size="14" /><Link2 v-else :size="14" />
          <span>{{ t(busy ? "settings.nodeOnboarding.connecting" : "settings.nodeOnboarding.connect") }}</span>
        </Button>
        <Button v-else-if="step === 'complete'" type="button" @click="closeDialog">{{ t("common.actions.done") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, Check, CircleAlert, CircleCheck, Clock3, Cloud, Copy, Download, Globe2, Link2, LoaderCircle, Network, RefreshCw, Server, ServerCog, TriangleAlert } from "@lucide/vue";
import type { NodeJoinedEvent } from "@task-handoff/protocol/control-plane";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { claimControlPlaneProxyNode, controlPlaneQueryKeys, createNode, createNodeJoinInvite, getNodeJoinInviteStatus } from "../../../api/queries";
import type { Node, NodeJoinInvite } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import { nodeAgentConnectCommand, nodeAgentInstallCommand } from "./nodeAgentInstallCommand";
import { normalizeProxyOrigin, proxyClaimValidation } from "./controlPlaneProxyUi";
import {
  applyReachabilityProbe,
  directEndpointIssue,
  initialReachabilityDecision,
  probeControlPlaneOrigin,
  reachabilityConflict,
  selectReachability,
  type ReachabilityValue,
} from "./nodeOnboardingState";

type Step = "network" | "target" | "connect" | "complete";
type ConnectionPath = "reverse" | "direct" | "proxy";

const props = defineProps<{
  open: boolean;
  publicBaseUrl: string;
  nodes: Node[];
  nodeJoinedEvent?: NodeJoinedEvent;
  version?: string;
}>();

const emit = defineEmits<{ close: []; created: [node: Node] }>();
const { t } = useI18n();
const { locale } = useControlPlaneLocale();
const queryClient = useQueryClient();
const step = ref<Step>("network");
const decision = ref(initialReachabilityDecision());
const controlPlaneOrigin = ref("");
const agentInstalled = ref<boolean>();
const nodeAgentPublic = ref<boolean>();
const nodeName = ref("");
const tokenSource = ref<"managed" | "standalone">("managed");
const reverseConnectionMethod = ref<"ui" | "command">("ui");
const joinInvite = ref<NodeJoinInvite>();
const pendingNodeId = ref("");
const completedNode = ref<Node>();
const busy = ref(false);
const copiedReverseValue = ref<"command" | "url" | "token">();
const operationError = ref("");
const directErrorField = ref<"endpoint" | "token" | "form">("form");
const proxyErrorField = ref<"origin" | "token" | "trust" | "form">("form");
const directDraft = reactive({ endpoint: "", joinToken: "", name: "" });
const proxyDraft = reactive({ proxyOrigin: "", inviteToken: "", name: "", trusted: false });
const nowMs = ref(Date.now());
let probeRevision = 0;
let clock: ReturnType<typeof setInterval> | undefined;
let inviteStatusTimer: ReturnType<typeof setTimeout> | undefined;
let inviteStatusRequest: AbortController | undefined;
const INVITE_STATUS_POLL_MS = 2_000;

const steps = computed(() => [
  { id: "network" as const, label: t("settings.nodeOnboarding.steps.network") },
  { id: "target" as const, label: t("settings.nodeOnboarding.steps.target") },
  { id: "connect" as const, label: t("settings.nodeOnboarding.steps.connect") },
  { id: "complete" as const, label: t("settings.nodeOnboarding.steps.complete") },
]);
const stepIndex = computed(() => steps.value.findIndex((item) => item.id === step.value));
const controlPlanePublic = computed(() => decision.value.selection.value === "publicly-reachable");
const connectionPath = computed<ConnectionPath>(() => controlPlanePublic.value ? "reverse" : nodeAgentPublic.value === true ? "direct" : "proxy");
const canContinueTarget = computed(() => controlPlanePublic.value ? agentInstalled.value !== undefined : nodeAgentPublic.value !== undefined);
const recommendedReachability = computed<ReachabilityValue>(() => decision.value.probe.status === "reachable" ? "publicly-reachable" : "not-publicly-reachable");
const installCommand = computed(() => {
  if (!joinInvite.value) return "";
  return agentInstalled.value
    ? nodeAgentConnectCommand({ controlPlaneUrl: controlPlaneOrigin.value, joinToken: joinInvite.value.joinToken })
    : nodeAgentInstallCommand({ controlPlaneUrl: controlPlaneOrigin.value, joinToken: joinInvite.value.joinToken, version: props.version });
});
const inviteExpired = computed(() => Boolean(joinInvite.value && Date.parse(joinInvite.value.expiresAt) <= nowMs.value));
const formattedExpiry = computed(() => joinInvite.value ? formatDateTime(new Date(joinInvite.value.expiresAt), locale.value) : "");
const probeLabel = computed(() => t(`settings.nodeOnboarding.network.status.${decision.value.probe.status}`, {
  origin: decision.value.probe.checkedOrigin || controlPlaneOrigin.value,
}));

watch(() => props.open, (open) => {
  if (!open) return;
  reset();
  void runProbe();
  clock = setInterval(() => { nowMs.value = Date.now(); }, 1_000);
});

watch(() => props.nodeJoinedEvent, (event) => {
  if (!event?.inviteId || event.inviteId !== joinInvite.value?.id) return;
  pendingNodeId.value = event.nodeId;
  void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes });
  completeFromSnapshot();
});

watch(() => props.nodes, completeFromSnapshot, { deep: false });
onBeforeUnmount(() => {
  stopClock();
  stopInviteStatusPolling();
});

function reset() {
  stopClock();
  stopInviteStatusPolling();
  probeRevision += 1;
  step.value = "network";
  decision.value = initialReachabilityDecision();
  controlPlaneOrigin.value = props.publicBaseUrl.trim() || window.location.origin;
  agentInstalled.value = undefined;
  nodeAgentPublic.value = undefined;
  nodeName.value = "";
  tokenSource.value = "managed";
  reverseConnectionMethod.value = "ui";
  joinInvite.value = undefined;
  pendingNodeId.value = "";
  completedNode.value = undefined;
  copiedReverseValue.value = undefined;
  busy.value = false;
  operationError.value = "";
  directErrorField.value = "form";
  proxyErrorField.value = "form";
  Object.assign(directDraft, { endpoint: "", joinToken: "", name: "" });
  Object.assign(proxyDraft, { proxyOrigin: "", inviteToken: "", name: "", trusted: false });
  nowMs.value = Date.now();
}

function stopClock() {
  if (clock) clearInterval(clock);
  clock = undefined;
}

async function runProbe() {
  const revision = ++probeRevision;
  decision.value = { ...decision.value, probe: { status: "checking", checkedOrigin: controlPlaneOrigin.value.trim() } };
  const probe = await probeControlPlaneOrigin(controlPlaneOrigin.value);
  if (revision !== probeRevision || !props.open) return;
  decision.value = applyReachabilityProbe(decision.value, probe);
}

function chooseControlPlaneReachability(value: ReachabilityValue) {
  decision.value = selectReachability(decision.value, value);
}

async function prepareConnection() {
  operationError.value = "";
  if (!controlPlanePublic.value) {
    step.value = "connect";
    return;
  }
  await createInvite();
}

async function createInvite() {
  if (busy.value) return;
  busy.value = true;
  try {
    stopInviteStatusPolling();
    joinInvite.value = await createNodeJoinInvite(nodeName.value.trim() ? { nodeName: nodeName.value.trim() } : {});
    copiedReverseValue.value = undefined;
    step.value = "connect";
    scheduleInviteStatusPoll(joinInvite.value.id, 0);
  } catch (error) {
    operationError.value = translateApiError(error, t);
  } finally {
    busy.value = false;
  }
}

function scheduleInviteStatusPoll(inviteId: string, delayMs = INVITE_STATUS_POLL_MS) {
  if (!props.open || step.value !== "connect" || joinInvite.value?.id !== inviteId || inviteExpired.value) return;
  if (inviteStatusTimer) clearTimeout(inviteStatusTimer);
  inviteStatusTimer = setTimeout(() => {
    inviteStatusTimer = undefined;
    void pollInviteStatus(inviteId);
  }, delayMs);
}

async function pollInviteStatus(inviteId: string) {
  if (!props.open || step.value !== "connect" || joinInvite.value?.id !== inviteId || inviteExpired.value) return;
  inviteStatusRequest?.abort();
  const request = new AbortController();
  inviteStatusRequest = request;
  try {
    const status = await getNodeJoinInviteStatus(inviteId, request.signal);
    if (request.signal.aborted || joinInvite.value?.id !== inviteId) return;
    if (status.status === "completed") {
      pendingNodeId.value = status.nodeId;
      await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes });
      completeFromSnapshot();
    }
  } catch (error) {
    if (!request.signal.aborted) console.warn("NODE_JOIN_INVITE_STATUS_RECOVERY_FAILED", error);
  } finally {
    if (inviteStatusRequest === request) inviteStatusRequest = undefined;
    scheduleInviteStatusPoll(inviteId);
  }
}

function stopInviteStatusPolling() {
  if (inviteStatusTimer) clearTimeout(inviteStatusTimer);
  inviteStatusTimer = undefined;
  inviteStatusRequest?.abort();
  inviteStatusRequest = undefined;
}

async function regenerateInvite() {
  await createInvite();
}

function chooseReverseMethod(method: "ui" | "command") {
  reverseConnectionMethod.value = method;
  copiedReverseValue.value = undefined;
}

async function copyReverseValue(kind: "command" | "url" | "token") {
  const value = kind === "command"
    ? installCommand.value
    : kind === "url"
      ? controlPlaneOrigin.value
      : joinInvite.value?.joinToken || "";
  if (!value || !navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(value);
    copiedReverseValue.value = kind;
  } catch {
    operationError.value = t("settings.nodeOnboarding.clipboardFailed");
  }
}

async function submitDirect() {
  operationError.value = "";
  const endpointIssue = directEndpointIssue(directDraft.endpoint);
  if (endpointIssue) {
    directErrorField.value = "endpoint";
    operationError.value = t(`settings.nodeOnboarding.direct.validation.${endpointIssue}`);
    return;
  }
  if (!directDraft.joinToken.trim()) {
    directErrorField.value = "token";
    operationError.value = t("settings.nodeOnboarding.direct.validation.token");
    return;
  }
  busy.value = true;
  try {
    const node = await createNode({
      name: directDraft.name.trim() || directDraft.endpoint.trim(),
      endpoint: directDraft.endpoint.trim(),
      joinToken: directDraft.joinToken.trim(),
      connectionMode: "direct-http",
    });
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes });
    markComplete(node);
  } catch (error) {
    directErrorField.value = "form";
    operationError.value = translateApiError(error, t);
  } finally {
    busy.value = false;
  }
}

async function submitProxy() {
  operationError.value = "";
  const issue = proxyClaimValidation(proxyDraft);
  if (issue) {
    proxyErrorField.value = issue;
    operationError.value = t(`settings.controlPlaneProxy.validation.${issue}`);
    return;
  }
  busy.value = true;
  try {
    const result = await claimControlPlaneProxyNode({
      proxyOrigin: normalizeProxyOrigin(proxyDraft.proxyOrigin),
      inviteToken: proxyDraft.inviteToken.trim(),
      name: proxyDraft.name.trim() || undefined,
    });
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes });
    markComplete(result.node);
  } catch (error) {
    proxyErrorField.value = "form";
    operationError.value = translateApiError(error, t);
  } finally {
    busy.value = false;
  }
}

function completeFromSnapshot() {
  if (!pendingNodeId.value) return;
  const node = props.nodes.find((item) => item.id === pendingNodeId.value);
  if (node) markComplete(node);
}

function markComplete(node: Node) {
  stopInviteStatusPolling();
  completedNode.value = node;
  directDraft.joinToken = "";
  proxyDraft.inviteToken = "";
  joinInvite.value = undefined;
  step.value = "complete";
  emit("created", node);
}

function goBack() {
  operationError.value = "";
  if (step.value === "target") step.value = "network";
  else if (step.value === "connect") {
    stopInviteStatusPolling();
    joinInvite.value = undefined;
    copiedReverseValue.value = undefined;
    step.value = "target";
  }
}

function closeDialog() {
  reset();
  emit("close");
}
</script>

<style scoped>
:global(.node-onboarding-dialog) {
  width: min(720px, calc(100vw - 32px));
  max-width: 720px;
  max-height: min(760px, calc(100dvh - 32px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  overflow: hidden;
}

.node-onboarding-progress {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 2px 0 4px;
  padding: 0 4px;
  list-style: none;
}

.node-onboarding-progress li {
  position: relative;
  display: grid;
  grid-template-rows: 28px auto;
  justify-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
}

.node-onboarding-progress li:not(:last-child)::after {
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

.node-onboarding-progress li.complete::after {
  background: hsl(var(--primary));
}

.node-onboarding-progress li > span {
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

.node-onboarding-progress li small {
  width: 100%;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.3;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-onboarding-progress li.active,
.node-onboarding-progress li.complete {
  color: var(--text-strong);
}

.node-onboarding-progress li.active > span,
.node-onboarding-progress li.complete > span {
  border-color: hsl(var(--primary));
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

.node-onboarding-progress li.active > span {
  box-shadow: 0 0 0 4px hsl(var(--primary) / 0.16);
}

.node-onboarding-progress li.active small {
  font-weight: 500;
}

.node-onboarding-scroll {
  min-height: 0;
}

.node-onboarding-content,
.node-onboarding-section {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.node-onboarding-content {
  padding: 2px 14px 2px 0;
}

.node-onboarding-section h3,
.node-onboarding-complete h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
}

.node-onboarding-section > p,
.node-onboarding-heading p,
.node-onboarding-complete p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.node-onboarding-heading,
.node-onboarding-command-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.node-onboarding-heading > div {
  display: grid;
  gap: 5px;
}

.node-onboarding-field {
  display: grid;
  gap: 6px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 400;
}

.node-onboarding-probe,
.node-onboarding-warning,
.node-onboarding-waiting,
.node-onboarding-instruction {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

.node-onboarding-probe[data-status="reachable"] { color: var(--status-success); }
.node-onboarding-probe[data-status="unreachable"],
.node-onboarding-warning,
.node-onboarding-waiting.expired { color: var(--status-warning); }
.node-onboarding-probe[data-status="checking"],
.node-onboarding-probe[data-status="inconclusive"],
.node-onboarding-waiting { color: var(--text-muted); }

.node-onboarding-choice-list {
  display: grid;
  gap: 8px;
}

.node-onboarding-choice,
.node-onboarding-relay-option {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
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
}

.node-onboarding-choice {
  cursor: pointer;
}

.node-onboarding-choice:hover,
.node-onboarding-choice.selected,
.node-onboarding-relay-option.selected {
  border-color: hsl(var(--primary));
  background: hsl(var(--accent) / 0.45);
}

.node-onboarding-choice > span,
.node-onboarding-relay-option > span {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.node-onboarding-choice strong,
.node-onboarding-relay-option strong {
  font-size: 13px;
  font-weight: 500;
}

.node-onboarding-choice small,
.node-onboarding-relay-option small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
}

.node-onboarding-relay-option.disabled {
  opacity: 0.62;
}

.node-onboarding-source-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-inset);
}

.node-onboarding-source-switch button {
  min-height: 32px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}

.node-onboarding-source-switch button.active {
  background: var(--surface);
  color: var(--text-strong);
  box-shadow: 0 0 0 1px var(--border);
}

.node-onboarding-command-head {
  align-items: center;
  color: var(--text-strong);
  font-size: 13px;
}

.node-onboarding-ui-connect {
  display: grid;
  gap: 12px;
}

.node-onboarding-ui-connect ol {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 22px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.node-onboarding-copy-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 10px;
}

.node-onboarding-copy-field > span {
  grid-column: 1 / -1;
  color: var(--text-strong);
  font-size: 12px;
}

.node-onboarding-copy-field code {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-inset);
  padding: 8px 10px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-onboarding-section pre {
  max-height: 220px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-inset);
  color: var(--text);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.node-onboarding-short-command {
  max-height: none !important;
}

.node-onboarding-trust {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}

.node-onboarding-error {
  margin: 0;
  color: var(--status-danger);
  font-size: 12px;
  line-height: 1.45;
}

.node-onboarding-complete {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 36px 12px;
  text-align: center;
}

.node-onboarding-complete > svg {
  color: var(--status-success);
}

.node-onboarding-footer {
  flex-wrap: nowrap;
}

.spin { animation: node-onboarding-spin 0.9s linear infinite; }
@keyframes node-onboarding-spin { to { transform: rotate(360deg); } }

@media (max-width: 560px) {
  :global(.node-onboarding-dialog) {
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 20px);
  }

  .node-onboarding-progress {
    padding: 0;
  }

  .node-onboarding-heading,
  .node-onboarding-command-head {
    align-items: stretch;
    flex-direction: column;
  }

  .node-onboarding-copy-field {
    grid-template-columns: minmax(0, 1fr);
  }

  .node-onboarding-copy-field > span {
    grid-column: auto;
  }

  .node-onboarding-copy-field > button {
    justify-self: stretch;
  }

  .node-onboarding-choice,
  .node-onboarding-relay-option {
    grid-template-columns: 22px minmax(0, 1fr);
  }

  .node-onboarding-badge {
    grid-column: 2;
    justify-self: start;
    white-space: nowrap;
  }
}
</style>
