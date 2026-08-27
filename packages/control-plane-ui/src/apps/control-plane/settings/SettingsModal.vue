<template>
  <section class="control-settings-page" :aria-label="t('settings.title')">
      <div class="control-settings-page-actions">
        <Button variant="outline" size="sm" @click="emit('back')">
          <ArrowLeft :size="14" />
          <span>{{ t("common.actions.back") }}</span>
        </Button>
        <Tabs :model-value="settingsSection" @update:model-value="(value) => setSettingsSection(value as SettingsSection)">
          <TabsList class="control-settings-tabs" :aria-label="t('settings.sections')">
            <TabsTrigger v-for="item in settingsSections" :key="item.id" :value="item.id">{{ item.label }}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea v-if="settingsSection === 'triggers'" class="settings-section-scroll" :horizontal="false">
        <div class="settings-section-scroll-content settings-content-column">
          <ControlPlaneTriggersView :instances="instances" />
        </div>
      </ScrollArea>

      <BasicSettingsSection
        v-else-if="settingsSection === 'basic'"
        :applying-server-update="applyingServerUpdate"
        :checking-server-update="checkingServerUpdate"
        :desktop-update-state="desktopUpdates.state.value"
        :desktop-updates-available="desktopUpdates.available"
        v-model:public-base-url="publicBaseUrl"
        :public-base-url-message="publicBaseUrlMessage"
        v-model:mention-trigger="mentionTrigger"
        :mention-trigger-error="mentionTriggerError"
        v-model:command-trigger="commandTrigger"
        :command-trigger-error="commandTriggerError"
        :saving-trigger-settings="savingTriggerSettings"
        :trigger-settings-at-defaults="triggerSettingsAtDefaults"
        :trigger-settings-dirty="triggerSettingsDirty"
        :trigger-settings-message="triggerSettingsMessage"
        :trigger-settings-message-error="triggerSettingsMessageError"
        :saving-public-base-url="savingPublicBaseUrl"
        :server-current-version="serverCurrentVersion"
        :server-unavailable-reason="serverUnavailableReason"
        :server-update-channel="updateChannel"
        :server-update-check="serverUpdateCheck"
        :server-update-job="serverUpdateJob"
        :server-updates-available="serverUpdatesAvailable"
        :theme-preference="themePreference"
        :diagnostic-logs="diagnosticLogs"
        :saving-diagnostic-logs="savingDiagnosticLogs"
        :exporting-diagnostic-logs="exportingDiagnosticLogs"
        @apply-server-update="applyServerUpdate"
        @check-server-update="checkServerUpdate"
        @check-desktop-update="runDesktopUpdateAction(desktopUpdates.check)"
        @download-desktop-update="runDesktopUpdateAction(desktopUpdates.download)"
        @detect-public-base-url="detectPublicBaseUrl"
        @save-public-base-url="savePublicBaseUrl"
        @reset-triggers="resetTriggerSettings"
        @install-desktop-update="runDesktopUpdateAction(desktopUpdates.install)"
        @open-desktop-release="runDesktopUpdateAction(desktopUpdates.openReleasePage)"
        @save-triggers="saveTriggerSettings"
        @update:server-update-channel="setUpdateChannel"
        @update:desktop-update-channel="setDesktopUpdateChannel"
        @update:theme-preference="setThemePreference"
        @update:diagnostic-logs="setDiagnosticLogs"
        @export-diagnostic-logs="exportDiagnosticLogs"
      />

      <ChatBridgeSettingsSection
        v-else-if="settingsSection === 'chat'"
        :chat="chatSettings"
        :error-text="errorText"
        :gateway-error="chatGatewayStatus.error.value"
        :is-refreshing="chatBridges.isFetching.value || chatGatewayStatus.isFetching.value"
        :refresh-chat="refreshChat"
      />

      <MobileSessionsSettingsSection v-else-if="settingsSection === 'mobile-sessions'" />

      <UserAccessSettingsSection v-else-if="settingsSection === 'users'" :nodes="nodes.data.value || []" :instances="instances" />

      <CloudConnectivitySettingsSection v-else-if="settingsSection === 'cloud-connectivity'" />

      <GitCredentialsSettingsSection v-else-if="settingsSection === 'git-credentials'" />

      <ModelSettingsSection v-else-if="settingsSection === 'models'" />

      <ImageSettingsSection v-else-if="settingsSection === 'images'" />

      <EnvironmentTemplatesSettings v-else-if="settingsSection === 'environment-templates'" :nodes="nodes.data.value || []" />

      <ProjectSettingsSection v-else-if="settingsSection === 'projects'" :can-manage-secrets="canManageSecrets" />

      <div v-else class="node-management-grid">
        <TooltipProvider :delay-duration="120">
          <section class="modal-section settings-panel-surface node-list-panel">
            <div class="section-head">
              <span>{{ t("settings.nodeRegistry.count", { count: nodes.data.value?.length || 0 }) }}</span>
              <div class="section-head-actions">
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="outline" size="sm">
                      <Plus :size="14" />
                      <span>{{ t("settings.nodeRegistry.add") }}</span>
                      <ChevronDown :size="13" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="node-add-menu" align="end" :side-offset="6">
                    <DropdownMenuItem class="node-add-menu-item node-onboarding-menu-item" @select="openNodeOnboarding">
                      <Sparkles :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ t("settings.nodeOnboarding.title") }}</strong>
                        <small>{{ t("settings.nodeOnboarding.description") }}</small>
                      </span>
                      <Badge class="node-onboarding-menu-badge" variant="secondary">{{ t("settings.nodeOnboarding.recommended") }}</Badge>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem v-if="!hasLocalNode" class="node-add-menu-item" :disabled="syncingLocalNode" @select="addLocalNode">
                      <MonitorCog :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ syncingLocalNode ? t("settings.nodeRegistry.addingLocal") : t("settings.nodeRegistry.addLocal") }}</strong>
                        <small>{{ t("settings.nodeRegistry.localDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="node-add-menu-item" @select="openRemoteNodeDialog">
                      <Server :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ t("settings.nodeRegistry.addRemote") }}</strong>
                        <small>{{ t("settings.nodeRegistry.remoteDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="node-add-menu-item" :disabled="creatingJoinInvite" @select="createJoinInvite">
                      <KeyRound :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ creatingJoinInvite ? t("settings.nodeRegistry.generatingToken") : t("settings.nodeRegistry.generateToken") }}</strong>
                        <small>{{ t("settings.nodeRegistry.tokenDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem class="node-add-menu-item" :disabled="creatingJoinInvite" @select="openNodeAgentInstallGuide">
                      <Download :size="16" aria-hidden="true" />
                      <span>
                        <strong>{{ creatingNodeAgentInstall ? t("settings.nodeRegistry.preparingGuide") : t("settings.nodeRegistry.installScript") }}</strong>
                        <small>{{ t("settings.nodeRegistry.installDescription") }}</small>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" :disabled="nodes.isFetching.value" @click="refresh">
                  <RefreshCw :size="14" />
                  <span>{{ nodes.isFetching.value ? t("common.actions.refreshing") : t("common.actions.refresh") }}</span>
                </Button>
              </div>
            </div>
            <div v-if="pendingProxyClaims.isLoading.value" class="pending-proxy-state" role="status">{{ t("settings.nodeDetail.loading") }}</div>
            <div v-else-if="pendingProxyClaims.error.value" class="pending-proxy-state control-plane-error" role="alert">
              <span>{{ translateApiError(pendingProxyClaims.error.value, t) }}</span>
              <Button type="button" size="sm" variant="outline" @click="pendingProxyClaims.refetch()">{{ t("common.actions.retry") }}</Button>
            </div>
            <div v-else-if="pendingProxyClaims.data.value?.length" class="pending-proxy-claims" role="region" :aria-label="t('settings.controlPlaneProxy.pendingClaims')">
              <div class="pending-proxy-heading">
                <AlertTriangle :size="15" aria-hidden="true" />
                <strong>{{ t("settings.controlPlaneProxy.pendingClaims") }}</strong>
              </div>
              <p>{{ t("settings.controlPlaneProxy.pendingClaimsDescription") }}</p>
              <p v-if="pendingClaimError" class="control-plane-error" role="alert">{{ pendingClaimError }}</p>
              <ScrollArea class="pending-proxy-list" :horizontal="false">
                <div class="pending-proxy-list-content">
                  <div v-for="claim in pendingProxyClaims.data.value" :key="claim.id" class="pending-proxy-row">
                    <span>{{ claim.proxyOrigin }} · {{ t(`settings.controlPlaneProxy.claimStatus.${claim.status}`) }}</span>
                    <div>
                      <Button type="button" size="sm" variant="outline" :disabled="Boolean(pendingClaimBusyId)" @click="resumeProxyClaim(claim.claimId)">
                        {{ pendingClaimBusyId === claim.claimId && pendingClaimAction === 'resume' ? t("settings.controlPlaneProxy.resuming") : t("settings.controlPlaneProxy.resume") }}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        :disabled="Boolean(pendingClaimBusyId)"
                        :aria-label="t(pendingClaimBusyId === claim.claimId && pendingClaimAction === 'cancel' ? 'settings.controlPlaneProxy.cancelling' : 'settings.controlPlaneProxy.cancelClaim')"
                        @click="cancelProxyClaim(claim.claimId)"
                      >
                        <RefreshCw v-if="pendingClaimBusyId === claim.claimId && pendingClaimAction === 'cancel'" class="proxy-spin" :size="14" />
                        <Trash2 v-else :size="14" />
                      </Button>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </div>
            <ScrollArea class="node-list">
              <div class="settings-scroll-content">
              <button v-for="target in orderedNodes" :key="target.id" type="button" class="node-list-item" :class="{ active: selectedNodeId === target.id }" @click="selectNode(target.id)">
                <span class="node-status-dot" :class="nodeStatusClass(target.id)" />
                <span>
                  <strong>{{ target.name }}</strong>
                  <small>{{ nodeLocationLabel(target) }} · {{ nodeEndpointDisplay(target.endpoint) || target.connectionMode }}</small>
                </span>
                <span class="node-list-meta">
                  <Tooltip @update:open="(open) => refreshNodeConnectionDiagnostics(open, target.id)">
                    <TooltipTrigger as-child>
                      <span class="node-diagnostic-badge" :aria-label="nodeBuildTitle(target.id)">
                        <Badge :variant="nodeStatusVariant(target.id)">{{ nodeStatusLabel(target.id) }}</Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent class="node-diagnostic-tooltip" align="end" side="bottom">
                      <div class="node-diagnostic-tooltip-grid">
                        <span><b>{{ t("settings.nodeRegistry.protocol") }}</b><em>{{ nodeProtocolLabel(target.id) }}</em></span>
                        <span><b>{{ t("settings.nodeRegistry.build") }}</b><em>{{ nodeBuildLabel(target.id) }}</em></span>
                        <span><b>{{ t("settings.nodeRegistry.package") }}</b><em>{{ nodePackageLabel(target.id) }}</em></span>
                        <span v-if="nodeBuild(target.id)?.imageRef"><b>{{ t("settings.nodeRegistry.image") }}</b><em>{{ nodeBuild(target.id)?.imageRef }}</em></span>
                        <span v-if="nodeBuild(target.id)?.builtAt"><b>{{ t("settings.nodeRegistry.built") }}</b><em>{{ nodeBuild(target.id)?.builtAt }}</em></span>
                      </div>
                      <NodeConnectionDiagnostics class="node-list-connection-diagnostics" :diagnostics="target.connectionDiagnostics" :event-transport="nodeEventTransport(target.id)" />
                    </TooltipContent>
                  </Tooltip>
                  <small>{{ nodeRuntimeSummary(target.id) }} · {{ nodeInstanceSummary(target.id) }}</small>
                </span>
              </button>
              <p v-if="!orderedNodes.length" class="settings-empty">{{ t("settings.nodeRegistry.empty") }}</p>
              </div>
            </ScrollArea>
          </section>

          <NodeDetailPanel
            :actions="nodeDetailActions"
            :busy="nodeDetailBusy"
            :resources="nodeDetailResources"
            :selected-node="selectedNode"
            :status="nodeDetailStatus"
          />
        </TooltipProvider>
      </div>
      <NodeStorageFolderPickerDialog
        :breadcrumbs="nodeStorageFolderBreadcrumbs"
        :can-confirm="nodeStorageFolderCanConfirm"
        :can-go-up="nodeStorageFolderCanGoUp"
        :current-path="nodeStorageFolderCurrentPath"
        :error="nodeStorageFolderError"
        :loading="nodeStorageFolderLoading"
        :node-name="nodeStorageFolderTarget?.name || ''"
        :open="nodeStorageFolderDialogOpen"
        :places="nodeStorageFolderPlaces"
        :rows="nodeStorageFolderRows"
        :selected-path="nodeStorageFolderSelectedPath"
        :submit-error="nodeStorageFolderSubmitError"
        :submitting="nodeStorageFolderSubmitting"
        @confirm="confirmNodeStorageFolder"
        @navigate="navigateNodeStorageFolder"
        @refresh="refreshNodeStorageFolderRoots"
        @select="selectNodeStorageFolder"
        @up="goUpNodeStorageFolder"
        @update:open="setNodeStorageFolderDialogOpen"
      />
      <NodeOnboardingDialog
        :node-joined-event="nodeJoinedEvent"
        :nodes="nodes.data.value || []"
        :open="nodeOnboardingOpen"
        :public-base-url="nodeAgentInstallControlPlaneUrl"
        :version="nodeAgentInstallVersion"
        @close="nodeOnboardingOpen = false"
        @created="handleOnboardingCreated"
      />
      <Dialog :open="nodeRenameOpen" @update:open="setNodeRenameOpen">
        <DialogContent class="node-rename-dialog">
          <DialogHeader>
            <DialogTitle>{{ t("settings.nodeRegistry.rename") }}</DialogTitle>
            <DialogDescription>{{ t("settings.nodeRegistry.renameDescription") }}</DialogDescription>
          </DialogHeader>

          <form class="node-rename-form" @submit.prevent="submitNodeRename">
            <label for="node-rename-name">{{ t("settings.fields.name") }}</label>
            <ControlPlaneInput
              id="node-rename-name"
              :model-value="nodeRenameDraft"
              :maxlength="160"
              :aria-invalid="Boolean(nodeRenameError)"
              :aria-describedby="nodeRenameError ? 'node-rename-error' : undefined"
              :disabled="Boolean(renamingNodeId)"
              autofocus
              @update:model-value="updateNodeRenameDraft"
            />
            <p v-if="nodeRenameError" id="node-rename-error" class="control-plane-error" role="alert">{{ nodeRenameError }}</p>

            <DialogFooter>
              <Button type="button" variant="outline" :disabled="Boolean(renamingNodeId)" @click="setNodeRenameOpen(false)">{{ t("common.actions.cancel") }}</Button>
              <Button type="submit" :disabled="!canSubmitNodeRename">
                <span>{{ t("common.actions.save") }}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog :open="remoteNodeDialogOpen" @update:open="setRemoteNodeDialogOpen">
        <DialogContent class="remote-node-dialog">
          <DialogHeader>
            <DialogTitle>{{ t("settings.nodeRegistry.addRemote") }}</DialogTitle>
            <DialogDescription>{{ t("settings.nodeRegistry.remoteDialogDescription") }}</DialogDescription>
          </DialogHeader>

          <form class="remote-node-form" @submit.prevent="submitRemoteNode">
            <ScrollArea class="remote-node-form-scroll" :horizontal="false">
              <div class="remote-node-form-content">
            <Tabs v-model="remoteNodeMode" class="remote-node-tabs">
              <TabsList class="remote-node-mode-tabs">
                <TabsTrigger value="direct">{{ t("settings.controlPlaneProxy.directMode") }}</TabsTrigger>
                <TabsTrigger value="control-plane-proxy">{{ t("settings.controlPlaneProxy.proxyMode") }}</TabsTrigger>
              </TabsList>
              <TabsContent value="direct" class="remote-node-mode-content">
                <label>
                  <span>{{ t("settings.fields.name") }}</span>
                  <ControlPlaneInput v-model="settingsNode.name" :placeholder="t('settings.nodeDetail.remoteNamePlaceholder')" />
                </label>
                <label>
                  <span>{{ t("settings.fields.endpoint") }}</span>
                  <!-- i18n-audit-allow-next-line code-token: example node endpoint -->
                  <ControlPlaneInput v-model="settingsNode.endpoint" placeholder="http://10.0.0.12:8091" />
                </label>
                <label>
                  <span>{{ t("settings.nodeRegistry.joinToken") }}</span>
                  <ControlPlaneInput v-model="settingsNode.joinToken" :placeholder="t('settings.nodeDetail.pairingTokenPlaceholder')" />
                </label>
              </TabsContent>
              <TabsContent value="control-plane-proxy" class="remote-node-mode-content">
                <div class="proxy-trust-notice">
                  <ShieldAlert :size="18" />
                  <span>{{ t("settings.controlPlaneProxy.trustWarning") }}</span>
                </div>
                <label>
                  <span>{{ t("settings.controlPlaneProxy.proxyOrigin") }}</span>
                  <!-- i18n-audit-allow-next-line code-token: example trusted control-plane origin -->
                  <ControlPlaneInput v-model="proxyNodeDraft.proxyOrigin" :aria-describedby="proxyNodeErrorField === 'origin' ? 'proxy-node-error' : undefined" :aria-invalid="proxyNodeErrorField === 'origin'" placeholder="https://control-plane.example.com" />
                </label>
                <div class="remote-node-field">
                  <label for="proxy-invite-token">{{ t("settings.controlPlaneProxy.inviteToken") }}</label>
                  <div class="proxy-token-input">
                    <ControlPlaneInput
                      id="proxy-invite-token"
                      v-model="proxyNodeDraft.inviteToken"
                      :aria-describedby="proxyNodeErrorField === 'token' ? 'proxy-node-error' : undefined"
                      :aria-invalid="proxyNodeErrorField === 'token'"
                      autocomplete="off"
                      :placeholder="t('settings.controlPlaneProxy.inviteTokenPlaceholder')"
                      :type="showProxyInviteToken ? 'text' : 'password'"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      :aria-label="t(showProxyInviteToken ? 'settings.controlPlaneProxy.hideToken' : 'settings.controlPlaneProxy.showToken')"
                      :aria-pressed="showProxyInviteToken"
                      @click="showProxyInviteToken = !showProxyInviteToken"
                    >
                      <EyeOff v-if="showProxyInviteToken" :size="15" />
                      <Eye v-else :size="15" />
                    </Button>
                  </div>
                </div>
                <label>
                  <span>{{ t("settings.fields.name") }}</span>
                  <ControlPlaneInput v-model="proxyNodeDraft.name" :placeholder="t('settings.controlPlaneProxy.optionalName')" />
                </label>
                <label class="proxy-trust-confirmation">
                  <Checkbox
                    :aria-describedby="proxyNodeErrorField === 'trust' ? 'proxy-node-error' : undefined"
                    :aria-invalid="proxyNodeErrorField === 'trust'"
                    :model-value="proxyNodeDraft.trusted"
                    @update:model-value="(value) => proxyNodeDraft.trusted = value === true"
                  />
                  <span>{{ t("settings.controlPlaneProxy.trustConfirmation") }}</span>
                </label>
              </TabsContent>
            </Tabs>
            <p v-if="proxyNodeError" id="proxy-node-error" class="control-plane-error" role="alert">{{ proxyNodeError }}</p>
            <p v-if="settingsNodeSuccess" class="settings-success">{{ settingsNodeSuccess }}</p>
              </div>
            </ScrollArea>

            <DialogFooter>
              <Button type="button" variant="outline" @click="setRemoteNodeDialogOpen(false)">{{ t("common.actions.cancel") }}</Button>
              <Button type="submit" :disabled="!canSubmitRemoteNode || creatingRemoteNode">
                <Plus :size="15" />
                <span>{{ creatingRemoteNode ? t("settings.nodeRegistry.creating") : t("settings.nodeRegistry.create") }}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GeneratedTokenDialog
        v-if="generatedToken"
        :expires-at="generatedToken.expiresAt"
        :title="t(generatedToken.titleKey)"
        :token="generatedToken.token"
        @close="generatedToken = undefined"
      />
      <NodeAgentInstallDialog
        v-if="nodeAgentInstallInvite"
        :expires-at="nodeAgentInstallInvite.expiresAt"
        :initial-control-plane-url="nodeAgentInstallControlPlaneUrl"
        :join-token="nodeAgentInstallInvite.joinToken"
        :open="Boolean(nodeAgentInstallInvite)"
        :version="nodeAgentInstallVersion"
        @close="nodeAgentInstallInvite = undefined"
      />
      <AlertDialog :open="Boolean(pendingClaimForceId)" @update:open="(open) => !open && (pendingClaimForceId = '')">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("settings.controlPlaneProxy.forceCancelTitle") }}</AlertDialogTitle>
            <AlertDialogDescription>{{ t("settings.controlPlaneProxy.forceCancelConfirm") }}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
            <AlertDialogAction :disabled="pendingClaimAction === 'force-cancel'" @click="forceCancelProxyClaim">
              {{ pendingClaimAction === 'force-cancel' ? t("settings.controlPlaneProxy.forceCancelling") : t("settings.controlPlaneProxy.forceCancel") }}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { AlertTriangle, ArrowLeft, ChevronDown, Download, Eye, EyeOff, KeyRound, MonitorCog, Plus, RefreshCw, Server, ShieldAlert, Sparkles, Trash2 } from "@lucide/vue";
import { cancelControlPlaneProxyClaim, claimControlPlaneProxyNode, controlPlaneQueryKeys, downloadControlPlaneDiagnosticLogs, getNodeExternalListener, resumeControlPlaneProxyClaim, updateControlPlaneSettings, updateNodeExternalListener, useAuthSessionQuery, useChatBridgesQuery, useChatGatewayStatusQuery, useControlPlaneSettingsQuery, useCurrentAccessQuery, useInstanceBoardPayloadQuery, useModelsQuery, useNodeRuntimesPayloadQuery, useNodesQuery, usePendingControlPlaneProxyClaimsQuery, useServerUpdateCheckQuery } from "../../../api/queries";
import { invalidateControlPlaneDomains } from "../../../api/queryInvalidation";
import type { BuildInfo, ControlPlaneSettings, InstanceBoardItem, Node, NodeAgentEventTransportHealth, NodeAgentExternalListener, UpdateChannel } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ControlPlaneTriggersView from "../triggers/ControlPlaneTriggersView.vue";
import { modelSupportsApp } from "../instance-settings/instanceSettingsState";
import BasicSettingsSection from "./AppearanceSettingsSection.vue";
import ChatBridgeSettingsSection from "./ChatBridgeSettingsSection.vue";
import MobileSessionsSettingsSection from "./MobileSessionsSettingsSection.vue";
import UserAccessSettingsSection from "./UserAccessSettingsSection.vue";
import { useChatBridgeSettings } from "./useChatBridgeSettings";
import { useNodeResourceSettings } from "./useNodeResourceSettings";
import { useNodeSettings } from "./useNodeSettings";
import { useDesktopUpdates, type DesktopUpdateChannel } from "./useDesktopUpdates";
import NodeDetailPanel from "./NodeDetailPanel.vue";
import NodeConnectionDiagnostics from "./NodeConnectionDiagnostics.vue";
import NodeOnboardingDialog from "./NodeOnboardingDialog.vue";
import NodeAgentInstallDialog from "./NodeAgentInstallDialog.vue";
import NodeStorageFolderPickerDialog from "./NodeStorageFolderPickerDialog.vue";
import GeneratedTokenDialog from "./GeneratedTokenDialog.vue";
import EnvironmentTemplatesSettings from "./EnvironmentTemplatesSettings.vue";
import ImageSettingsSection from "./ImageSettingsSection.vue";
import CloudConnectivitySettingsSection from "./CloudConnectivitySettingsSection.vue";
import GitCredentialsSettingsSection from "./GitCredentialsSettingsSection.vue";
import ModelSettingsSection from "./ModelSettingsSection.vue";
import ProjectSettingsSection from "./ProjectSettingsSection.vue";
import { nodeEndpointDisplay } from "./nodeEndpointDisplay";
import { getThemePreference, saveThemePreference, type ThemePreference } from "../../../utils/theme";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { connectionStatusKeys, translateStatus } from "../../../i18n/status";
import { translateApiError } from "../../../i18n/apiError";
import { normalizeProxyOrigin, proxyClaimForceDeleteAllowed, proxyClaimValidation } from "./controlPlaneProxyUi";
import type { NodeJoinedEvent } from "@task-handoff/protocol/control-plane";
import { buildSettingsSections, type SettingsSection } from "./settingsSections";

type NodeDiagnosticLog = {
  route: string;
  method: string;
  code: string;
  message: string;
  statusCode?: number;
  issues?: Array<{ path: string; message: string }>;
};

const props = defineProps<{
  chooseProjectFolder?: () => Promise<string | { path: string; ownerNodeId?: string } | undefined>;
  initialSection?: SettingsSection;
  instances: InstanceBoardItem[];
  nodeJoinedEvent?: NodeJoinedEvent;
}>();

const emit = defineEmits<{
  back: [];
  openInstanceSettings: [instanceId: string];
  "section-change": [section: SettingsSection];
}>();

const { t } = useI18n();

const authSession = useAuthSessionQuery();
const currentAccess = useCurrentAccessQuery(computed(() => Boolean(authSession.data.value?.enabled && authSession.data.value.authenticated)));
const canManageUsers = computed(() => currentAccess.data.value?.permissionIds.includes("users:manage") === true);
const canManageSettings = computed(() => currentAccess.data.value?.permissionIds.includes("settings:manage") === true);
const canManageSecrets = computed(() => authSession.data.value?.enabled !== true || currentAccess.data.value?.permissionIds.includes("secrets:manage") === true);
const settingsSections = computed(() => buildSettingsSections(t, {
  manageSecrets: canManageSecrets.value,
  manageSettings: canManageSettings.value,
  manageUsers: canManageUsers.value,
}));

const settingsSection = ref<SettingsSection>(props.initialSection || "nodes");
const queryClient = useQueryClient();
const models = useModelsQuery();
const nodes = useNodesQuery();
const nodeRuntimes = useNodeRuntimesPayloadQuery();
const board = useInstanceBoardPayloadQuery();
const chatBridges = useChatBridgesQuery();
const chatGatewayStatus = useChatGatewayStatusQuery();
const controlPlaneSettings = useControlPlaneSettingsQuery();
const desktopUpdates = useDesktopUpdates();
const updateChannel = computed<UpdateChannel>(() => controlPlaneSettings.data.value?.updateChannel || "stable");
const diagnosticLogs = computed(() => controlPlaneSettings.data.value?.diagnosticLogs === true);

watch([canManageUsers, canManageSettings, canManageSecrets], ([manageUsers, manageSettings, manageSecrets]) => {
  if (!manageSettings && settingsSection.value === "cloud-connectivity") setSettingsSection("nodes");
  if (!manageUsers && settingsSection.value === "users") setSettingsSection("nodes");
  if (!manageSecrets && settingsSection.value === "git-credentials") setSettingsSection("nodes");
}, { immediate: true });
const themePreference = ref<ThemePreference>(getThemePreference());
const publicBaseUrl = ref("");
const publicBaseUrlMessage = ref("");
const savingPublicBaseUrl = ref(false);
const savingDiagnosticLogs = ref(false);
const exportingDiagnosticLogs = ref(false);
const mentionTrigger = ref("@");
const mentionTriggerError = computed(() => validMentionTrigger(mentionTrigger.value) ? "" : t("settings.composer.mentionInvalid"));
const commandTrigger = ref("/");
const triggerSettingsMessage = ref("");
const triggerSettingsMessageError = ref(false);
const savingTriggerSettings = ref(false);
const commandTriggerError = computed(() => validCommandTrigger(commandTrigger.value) ? "" : t("settings.composer.commandInvalid"));
const triggerSettingsAtDefaults = computed(() => commandTrigger.value === "/" && mentionTrigger.value === "@");
const triggerSettingsDirty = computed(() => mentionTrigger.value !== (controlPlaneSettings.data.value?.mentionTrigger || "@") || commandTrigger.value !== (controlPlaneSettings.data.value?.commandTrigger || "/"));
const remoteNodeDialogOpen = ref(false);
const nodeOnboardingOpen = ref(false);
const remoteNodeMode = ref<"direct" | "control-plane-proxy">("direct");
const creatingProxyNode = ref(false);
const proxyNodeError = ref("");
const proxyNodeErrorField = ref<"origin" | "token" | "trust" | "form">("form");
const proxyNodeDraft = ref({ proxyOrigin: "", inviteToken: "", name: "", trusted: false });
const showProxyInviteToken = ref(false);
const pendingClaimBusyId = ref("");
const pendingClaimAction = ref<"resume" | "cancel" | "force-cancel">();
const pendingClaimError = ref("");
const pendingClaimForceId = ref("");
const pendingProxyClaims = usePendingControlPlaneProxyClaimsQuery();
const creatingNodeAgentInstall = ref(false);
const nodeAgentInstallInvite = ref<{ joinToken: string; expiresAt: string }>();
const nodeAgentInstallControlPlaneUrl = computed(() => publicBaseUrl.value.trim() || window.location.origin);
const codexModels = computed(() => (models.data.value || []).filter((model) => modelSupportsApp(model, "codex")));
const claudeModels = computed(() => (models.data.value || []).filter((model) => modelSupportsApp(model, "claude")));
const nodeRuntimeItems = computed(() => nodeRuntimes.data.value?.data || []);
const boardItems = computed(() => board.data.value?.data || []);
const nodeDiagnosticsByNodeId = computed(() => {
  const diagnostics: Record<string, NodeDiagnosticLog[]> = {};
  const seen = new Set<string>();
  for (const error of [...(nodeRuntimes.data.value?.meta?.nodeErrors || []), ...(board.data.value?.meta?.nodeErrors || [])]) {
    const issuesKey = JSON.stringify(error.issues || []);
    const key = `${error.nodeId}:${error.method}:${error.route}:${error.code}:${error.message}:${error.statusCode || ""}:${issuesKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    (diagnostics[error.nodeId] ||= []).push({
      route: error.route,
      method: error.method,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      issues: error.issues?.map((issue) => ({
        path: issue.path?.join(".") || "",
        message: issue.message,
      })),
    });
  }
  return diagnostics;
});

watch(
  () => props.initialSection,
  (section) => {
    if (section) {
      if (section !== "nodes") closeNodeStorageFolderPicker();
      settingsSection.value = section;
    }
  },
);

watch(
  () => controlPlaneSettings.data.value?.publicBaseUrl,
  (value) => {
    publicBaseUrl.value = value || "";
  },
  { immediate: true },
);

watch(
  () => controlPlaneSettings.data.value?.mentionTrigger,
  (value) => {
    mentionTrigger.value = value || "@";
  },
  { immediate: true },
);

watch(
  () => controlPlaneSettings.data.value?.commandTrigger,
  (value) => {
    commandTrigger.value = value || "/";
  },
  { immediate: true },
);

watch(
  () => controlPlaneSettings.data.value?.diagnosticLogs,
  (enabled) => {
    if (typeof enabled !== "boolean") return;
    void (window as Window & {
      taskHandoffDesktop?: { setDiagnosticLogsEnabled?: (value: boolean) => Promise<unknown> };
    }).taskHandoffDesktop?.setDiagnosticLogsEnabled?.(enabled);
  },
  { immediate: true },
);

async function refresh() {
  await invalidateControlPlaneDomains(queryClient, ["manual"]);
}

const refreshNodeTopology = () => invalidateControlPlaneDomains(queryClient, ["nodeTopology"]);
const refreshNodeRuntimeState = () => invalidateControlPlaneDomains(queryClient, ["nodeRuntimeState"]);
const refreshNodeFolders = () => invalidateControlPlaneDomains(queryClient, ["nodeFolders"]);

async function syncRenamedNode(renamed: Node) {
  queryClient.setQueryData<Node[]>(["control-plane-nodes"], (current) => {
    if (!current) return [renamed];
    return current.map((node) => node.id === renamed.id ? renamed : node);
  });
  await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodes }),
    queryClient.refetchQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
  ]);
}

const chatSettings = useChatBridgeSettings({
  bridges: chatBridges.data,
  errorText,
  gatewayStatus: chatGatewayStatus.data,
  refresh: refreshChat,
  translate: t,
});
const {
  checkingRuntimeId,
  closeNodeStorageFolderPicker,
  confirmNodeStorageFolder,
  goUpNodeStorageFolder,
  creatingNodeLocalFolder,
  deletingNodeLocalFolderId,
  deletingRuntimeId,
  isControlPlaneBuiltinNode,
  isControlPlaneLocalNode,
  nodeLocalFolders,
  nodeStorageFolderCanConfirm,
  nodeStorageFolderBreadcrumbs,
  nodeStorageFolderCanGoUp,
  nodeStorageFolderCurrentPath,
  nodeStorageFolderDialogOpen,
  nodeStorageFolderError,
  nodeStorageFolderLoading,
  nodeStorageFolderPlaces,
  nodeStorageFolderRows,
  nodeStorageFolderSelectedPath,
  nodeStorageFolderSubmitError,
  nodeStorageFolderSubmitting,
  nodeStorageFolderTarget,
  navigateNodeStorageFolder,
  nodeLocationLabel,
  orderedNodes,
  removeNodeLocalFolder,
  renameNodeLocalFolder,
  renamingNodeLocalFolderId,
  removeRuntime,
  runtimeName,
  checkRuntime,
  selectedNode,
  selectedNodeId,
  selectedNodeInstances,
  selectedNodeIsLocal,
  selectedNodeRuntimes,
  selectNode,
  selectNodeStorageFolder,
  setNodeStorageFolderDialogOpen,
  submitNodeLocalFolder,
  refreshNodeStorageFolderRoots,
} = useNodeResourceSettings({
  chooseProjectFolder: props.chooseProjectFolder,
  errorText,
  instances: boardItems,
  nodes: nodes.data,
  refreshFolders: refreshNodeFolders,
  refreshRuntimeState: refreshNodeRuntimeState,
  runtimes: nodeRuntimeItems,
  translate: t,
});
const externalListener = ref<NodeAgentExternalListener>();
const externalListenerBindScope = ref<NodeAgentExternalListener["bindScope"]>("loopback");
const externalListenerPort = ref("8091");
const externalListenerError = ref("");
const loadingExternalListener = ref(false);
const savingExternalListener = ref(false);

async function loadExternalListener() {
  const node = selectedNode.value;
  if (!node || !isControlPlaneBuiltinNode(node)) {
    externalListener.value = undefined;
    externalListenerError.value = "";
    return;
  }
  loadingExternalListener.value = true;
  externalListenerError.value = "";
  try {
    const listener = await getNodeExternalListener(node.id);
    externalListener.value = listener;
    externalListenerBindScope.value = listener.bindScope;
    externalListenerPort.value = String(listener.port);
  } catch (error) {
    externalListenerError.value = errorText(error);
  } finally {
    loadingExternalListener.value = false;
  }
}

function updateExternalListenerDraft(field: "bindScope" | "port", value: string) {
  if (field === "bindScope") {
    if (value === "loopback" || value === "all-ipv4") externalListenerBindScope.value = value;
    return;
  }
  externalListenerPort.value = value;
}

async function saveExternalListener() {
  const node = selectedNode.value;
  if (!node || !isControlPlaneBuiltinNode(node) || savingExternalListener.value) return;
  const port = Number(externalListenerPort.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    externalListenerError.value = t("settings.nodeDetail.invalidListenerPort");
    return;
  }
  const scopeChangedToAll = externalListener.value?.bindScope !== "all-ipv4" && externalListenerBindScope.value === "all-ipv4";
  const portChanged = externalListener.value?.port !== port;
  const warnings = [
    scopeChangedToAll ? t("settings.nodeDetail.listenerExposeWarning") : "",
    portChanged ? t("settings.nodeDetail.listenerEndpointWarning") : "",
  ].filter(Boolean);
  if (warnings.length && !window.confirm(`${warnings.join("\n\n")}\n\n${t("settings.nodeDetail.listenerApplyConfirm")}`)) return;

  savingExternalListener.value = true;
  externalListenerError.value = "";
  try {
    externalListener.value = await updateNodeExternalListener(node.id, { bindScope: externalListenerBindScope.value, port });
    showControlPlaneToast(t("settings.nodeDetail.listenerUpdated"), "success");
  } catch (error) {
    externalListenerError.value = errorText(error);
    showControlPlaneToast(externalListenerError.value);
  } finally {
    savingExternalListener.value = false;
    await loadExternalListener();
  }
}

watch(
  () => selectedNode.value?.id,
  () => { void loadExternalListener(); },
  { immediate: true },
);
const hasLocalNode = computed(() => (nodes.data.value || []).some(isControlPlaneLocalNode));
const {
  addLocalNode,
  applyManagedUpdate,
  applyingUpdateNodeId,
  canConnectRemote,
  canCreateNode,
  canSubmitNodeRename,
  checkSettingsNode,
  checkManagedUpdate,
  checkingUpdateNodeId,
  checkingNodeId,
  clearNodeFeedback,
  connectSelectedNodeToRemote,
  connectingRemoteNodeId,
  createJoinInvite,
  createPairingInviteForNode,
  createSettingsNode,
  generatedToken,
  creatingJoinInvite,
  creatingPairingInviteNodeId,
  creatingNode,
  deletingNodeId,
  deletingRemoteKeyId,
  deletingControlPlaneConnectionId,
  loadControlPlaneAccess,
  loadManagedUpdateJobs,
  loadNodeImages,
  loadingRemoteKeysNodeId,
  loadingNodeImagesId,
  nodeRenameDraft,
  nodeRenameError,
  nodeRenameOpen,
  openNodeRename,
  removeNode,
  removeRemoteKey,
  removeControlPlaneConnection,
  renamingNodeId,
  resetNodeRename,
  nodeImageError,
  nodeImages,
  nodeStatusById,
  nodeNameById,
  selectedImageNodeId,
  remoteConnectResultByNodeId,
  controlPlanePairingsByNodeId,
  controlPlaneConnectionsByNodeId,
  remoteKeysErrorByNodeId,
  remoteConnect,
  settingsNode,
  settingsNodeSuccess,
  setNodeRenameOpen,
  submitNodeRename,
  syncingLocalNode,
  updateChecks,
  updateJobs,
  updateNodeRenameDraft,
} = useNodeSettings({
  errorText,
  onNodeRenamed: syncRenamedNode,
  refreshNodeRuntimeState,
  refreshNodeTopology,
  nodes: () => nodes.data.value || [],
  updateChannel: () => updateChannel.value,
  translate: t,
});

function openRemoteNodeDialog() {
  clearNodeFeedback();
  proxyNodeError.value = "";
  proxyNodeErrorField.value = "form";
  remoteNodeDialogOpen.value = true;
}

function openNodeOnboarding() {
  nodeOnboardingOpen.value = true;
}

function handleOnboardingCreated(node: Node) {
  selectNode(node.id);
}

const canSubmitRemoteNode = computed(() => remoteNodeMode.value === "direct"
  ? canCreateNode.value
  : !proxyClaimValidation(proxyNodeDraft.value));
const creatingRemoteNode = computed(() => creatingNode.value || creatingProxyNode.value);

async function openNodeAgentInstallGuide() {
  if (creatingNodeAgentInstall.value) return;
  creatingNodeAgentInstall.value = true;
  try {
    const invite = await createJoinInvite(false);
    if (invite) nodeAgentInstallInvite.value = invite;
  } finally {
    creatingNodeAgentInstall.value = false;
  }
}

function setRemoteNodeDialogOpen(open: boolean) {
  remoteNodeDialogOpen.value = open;
  if (!open) {
    clearNodeFeedback();
    proxyNodeError.value = "";
    proxyNodeErrorField.value = "form";
    proxyNodeDraft.value = { proxyOrigin: "", inviteToken: "", name: "", trusted: false };
    showProxyInviteToken.value = false;
  }
}

async function submitRemoteNode() {
  if (remoteNodeMode.value === "control-plane-proxy") {
    await submitProxyNode();
    return;
  }
  await createSettingsNode();
  if (settingsNodeSuccess.value) {
    setRemoteNodeDialogOpen(false);
  }
}

function proxyValidationMessage() {
  const issue = proxyClaimValidation(proxyNodeDraft.value);
  proxyNodeErrorField.value = issue || "form";
  return issue ? t(`settings.controlPlaneProxy.validation.${issue}`) : "";
}

async function submitProxyNode() {
  proxyNodeError.value = proxyValidationMessage();
  if (proxyNodeError.value || creatingProxyNode.value) return;
  creatingProxyNode.value = true;
  try {
    const result = await claimControlPlaneProxyNode({
      proxyOrigin: normalizeProxyOrigin(proxyNodeDraft.value.proxyOrigin),
      inviteToken: proxyNodeDraft.value.inviteToken.trim(),
      name: proxyNodeDraft.value.name.trim() || undefined,
    });
    await invalidateControlPlaneDomains(queryClient, ["nodeTopology", "controlPlaneProxy"]);
    selectNode(result.node.id);
    setRemoteNodeDialogOpen(false);
    showControlPlaneToast(t("settings.controlPlaneProxy.nodeAdded", { name: result.node.name }), "success");
  } catch (error) {
    proxyNodeErrorField.value = "form";
    proxyNodeError.value = translateApiError(error, t);
    await pendingProxyClaims.refetch();
  } finally {
    creatingProxyNode.value = false;
  }
}

async function resumeProxyClaim(id: string) {
  if (pendingClaimBusyId.value) return;
  pendingClaimBusyId.value = id;
  pendingClaimAction.value = "resume";
  pendingClaimError.value = "";
  try {
    const result = await resumeControlPlaneProxyClaim(id);
    await invalidateControlPlaneDomains(queryClient, ["nodeTopology", "controlPlaneProxy"]);
    selectNode(result.node.id);
    setRemoteNodeDialogOpen(false);
  } catch (error) {
    pendingClaimError.value = translateApiError(error, t);
  } finally {
    pendingClaimBusyId.value = "";
    pendingClaimAction.value = undefined;
  }
}

async function cancelProxyClaim(id: string) {
  if (pendingClaimBusyId.value) return;
  pendingClaimBusyId.value = id;
  pendingClaimAction.value = "cancel";
  pendingClaimError.value = "";
  try {
    await cancelControlPlaneProxyClaim(id);
    await pendingProxyClaims.refetch();
  } catch (error) {
    if (proxyClaimForceDeleteAllowed(error)) {
      pendingClaimForceId.value = id;
    } else {
      pendingClaimError.value = translateApiError(error, t);
    }
  } finally {
    pendingClaimBusyId.value = "";
    pendingClaimAction.value = undefined;
  }
}

async function forceCancelProxyClaim() {
  const id = pendingClaimForceId.value;
  if (!id || pendingClaimBusyId.value) return;
  pendingClaimBusyId.value = id;
  pendingClaimAction.value = "force-cancel";
  pendingClaimError.value = "";
  try {
    const result = await cancelControlPlaneProxyClaim(id, true);
    await pendingProxyClaims.refetch();
    if (!result.deleted && pendingProxyClaims.data.value?.some((claim) => claim.claimId === id)) {
      pendingClaimError.value = t("settings.controlPlaneProxy.forceCancelFailed");
      return;
    }
    pendingClaimForceId.value = "";
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    pendingClaimBusyId.value = "";
    pendingClaimAction.value = undefined;
  }
}

async function setUpdateChannel(value: string) {
  if (value !== "stable" && value !== "beta" && value !== "alpha") return;
  try {
    const saved = await updateControlPlaneSettings({ updateChannel: value });
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
    for (const key of Object.keys(updateChecks)) delete updateChecks[key];
  } catch (error) {
    showControlPlaneToast(errorText(error));
  }
}

async function setDiagnosticLogs(enabled: boolean) {
  if (savingDiagnosticLogs.value || enabled === diagnosticLogs.value) return;
  savingDiagnosticLogs.value = true;
  try {
    const saved = await updateControlPlaneSettings({ diagnosticLogs: enabled });
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
    showControlPlaneToast(t(enabled ? "settings.diagnosticLogs.enabledMessage" : "settings.diagnosticLogs.disabledMessage"), "success");
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    savingDiagnosticLogs.value = false;
  }
}

async function exportDiagnosticLogs() {
  if (exportingDiagnosticLogs.value) return;
  exportingDiagnosticLogs.value = true;
  try {
    const { blob, filename } = await downloadControlPlaneDiagnosticLogs();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showControlPlaneToast(t("settings.diagnosticLogs.exported"), "success");
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    exportingDiagnosticLogs.value = false;
  }
}

const serverUpdateNode = computed(() => (nodes.data.value || []).find((node) => isControlPlaneBuiltinNode(node)));
const serverUpdateNodeId = computed(() => serverUpdateNode.value?.id || "");
const isDesktopApp = Boolean((window as Window & { taskHandoffDesktop?: unknown }).taskHandoffDesktop);
const serverUpdatesAvailable = computed(() => Boolean(serverUpdateNodeId.value && !isDesktopApp));
const serverUnavailableReason = computed(() => isDesktopApp ? t("settings.appearance.desktopReleaseOnly") : t("settings.appearance.builtinServerUnavailable"));
const serverUpdateQueryNodeId = computed(() => serverUpdatesAvailable.value ? serverUpdateNodeId.value : "");
const serverUpdateQuery = useServerUpdateCheckQuery(serverUpdateQueryNodeId, updateChannel);
const serverUpdateCheck = computed(() => serverUpdateQuery.data.value);
const serverCurrentVersion = computed(() => serverUpdateNodeId.value ? nodeBuild(serverUpdateNodeId.value)?.packageVersion : undefined);
const nodeAgentInstallVersion = computed(() => {
  const version = serverCurrentVersion.value?.trim();
  return version && version !== "unknown" ? version : undefined;
});
const serverUpdateJob = computed(() => updateJobs.value.find((job) => job.nodeId === serverUpdateNodeId.value));
const checkingServerUpdate = computed(() => serverUpdateQuery.isFetching.value);
const applyingServerUpdate = computed(() => applyingUpdateNodeId.value === serverUpdateNodeId.value);

async function checkServerUpdate() {
  if (serverUpdatesAvailable.value) await serverUpdateQuery.refetch();
}

async function applyServerUpdate() {
  if (serverUpdatesAvailable.value) await applyManagedUpdate(serverUpdateNodeId.value, serverUpdateCheck.value);
}

async function runDesktopUpdateAction(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    showControlPlaneToast(errorText(error));
  }
}

async function setDesktopUpdateChannel(value: string) {
  if (value !== "stable" && value !== "beta" && value !== "alpha") return;
  await runDesktopUpdateAction(() => desktopUpdates.setChannel(value as DesktopUpdateChannel));
}

const nodeDetailActions = computed(() => ({
  checkRuntime,
  checkSettingsNode,
  checkManagedUpdate,
  applyManagedUpdate,
  connectSelectedNodeToRemote,
  createPairingInviteForNode,
  loadNodeImages,
  loadControlPlaneAccess,
  loadManagedUpdateJobs,
  openInstanceSettings: (instanceId: string) => emit("openInstanceSettings", instanceId),
  openNodeRename,
  removeNode,
  removeNodeLocalFolder,
  renameNodeLocalFolder,
  removeRemoteKey,
  removeControlPlaneConnection,
  removeRuntime,
  saveExternalListener,
  submitNodeLocalFolder,
  setUpdateChannel,
  updateExternalListenerDraft,
  updateRemoteConnect,
}));

const nodeDetailBusy = computed(() => ({
  checkingNodeId: checkingNodeId.value,
  checkingUpdateNodeId: checkingUpdateNodeId.value,
  applyingUpdateNodeId: applyingUpdateNodeId.value,
  checkingRuntimeId: checkingRuntimeId.value,
  connectingRemoteNodeId: connectingRemoteNodeId.value,
  creatingNodeLocalFolder: creatingNodeLocalFolder.value,
  creatingPairingInviteNodeId: creatingPairingInviteNodeId.value,
  deletingNodeId: deletingNodeId.value,
  deletingNodeLocalFolderId: deletingNodeLocalFolderId.value,
  renamingNodeLocalFolderId: renamingNodeLocalFolderId.value,
  deletingRemoteKeyId: deletingRemoteKeyId.value,
  deletingControlPlaneConnectionId: deletingControlPlaneConnectionId.value,
  deletingRuntimeId: deletingRuntimeId.value,
  loadingNodeImagesId: loadingNodeImagesId.value,
  loadingRemoteKeysNodeId: loadingRemoteKeysNodeId.value,
  loadingExternalListener: loadingExternalListener.value,
  renamingNodeId: renamingNodeId.value,
  savingExternalListener: savingExternalListener.value,
}));

const nodeDetailResources = computed(() => ({
  canConnectRemote: canConnectRemote.value,
  images: nodeImages.value,
  imagesError: nodeImageError.value,
  instances: selectedNodeInstances.value,
  localFoldersError: nodeLocalFolders.error.value ? errorText(nodeLocalFolders.error.value) : "",
  localFolders: nodeLocalFolders.data.value || [],
  remoteConnect,
  remoteConnectResultByNodeId,
  controlPlanePairings: selectedNode.value ? controlPlanePairingsByNodeId[selectedNode.value.id] || [] : [],
  controlPlaneConnections: selectedNode.value ? controlPlaneConnectionsByNodeId[selectedNode.value.id] || [] : [],
  remoteKeysError: selectedNode.value ? remoteKeysErrorByNodeId[selectedNode.value.id] || "" : "",
  diagnostics: selectedNode.value ? nodeDiagnosticsByNodeId.value[selectedNode.value.id] || [] : [],
  externalListener: externalListener.value,
  externalListenerBindScope: externalListenerBindScope.value,
  externalListenerError: externalListenerError.value,
  externalListenerPort: externalListenerPort.value,
  runtimes: selectedNodeRuntimes.value,
  selectedImageNodeId: selectedImageNodeId.value,
  selectedNodeIsLocal: selectedNodeIsLocal.value,
  updateChannel: updateChannel.value,
  updateChecks,
  updateJobs: updateJobs.value,
}));

const nodeDetailStatus = {
  build: nodeBuild,
  buildLabel: nodeBuildLabel,
  buildTitle: nodeBuildTitle,
  eventTransport: nodeEventTransport,
  isBuiltinNode: isControlPlaneBuiltinNode,
  locationLabel: nodeLocationLabel,
  nameById: nodeNameById,
  packageLabel: nodePackageLabel,
  protocolLabel: nodeProtocolLabel,
  statusLabel: nodeStatusLabel,
  statusVariant: nodeStatusVariant,
};

watch(
  () => selectedNode.value?.id,
  (nodeId, previousNodeId) => {
    if (previousNodeId && nodeId !== previousNodeId) resetNodeRename();
    if (nodeId) {
      void loadControlPlaneAccess(nodeId);
      void loadManagedUpdateJobs(nodeId);
    }
  },
  { immediate: true },
);

async function setSettingsSection(section: SettingsSection) {
  if (section !== "nodes") closeNodeStorageFolderPicker();
  settingsSection.value = section;
  emit("section-change", section);
  clearNodeFeedback();
  publicBaseUrlMessage.value = "";
  if (section === "chat") {
    await refreshChat();
  }
  if (section === "basic" && serverUpdateNodeId.value) {
    await loadManagedUpdateJobs(serverUpdateNodeId.value);
  }
}

function setThemePreference(theme: ThemePreference) {
  themePreference.value = theme;
  saveThemePreference(theme);
}

function detectPublicBaseUrl() {
  publicBaseUrl.value = window.location.origin;
  publicBaseUrlMessage.value = t("settings.publicAccess.currentFilled");
}

async function savePublicBaseUrl() {
  if (savingPublicBaseUrl.value) {
    return;
  }
  savingPublicBaseUrl.value = true;
  publicBaseUrlMessage.value = "";
  try {
    const saved = await updateControlPlaneSettings({ publicBaseUrl: publicBaseUrl.value.trim() || undefined });
    publicBaseUrl.value = saved.publicBaseUrl || "";
    publicBaseUrlMessage.value = t("settings.publicAccess.saved");
    await queryClient.invalidateQueries({ queryKey: ["control-plane-settings"] });
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    savingPublicBaseUrl.value = false;
  }
}

function validMentionTrigger(value: string) {
  return Array.from(value).length === 1 && !/[\p{L}\p{N}\s/\\]/u.test(value);
}

function resetTriggerSettings() {
  commandTrigger.value = "/";
  mentionTrigger.value = "@";
  triggerSettingsMessage.value = t("settings.composer.defaultsReady");
  triggerSettingsMessageError.value = false;
}

async function saveTriggerSettings() {
  if (savingTriggerSettings.value || !triggerSettingsDirty.value || !validMentionTrigger(mentionTrigger.value) || !validCommandTrigger(commandTrigger.value)) return;
  savingTriggerSettings.value = true;
  triggerSettingsMessage.value = "";
  triggerSettingsMessageError.value = false;
  try {
    const saved = await updateControlPlaneSettings({
      commandTrigger: commandTrigger.value,
      mentionTrigger: mentionTrigger.value,
    });
    commandTrigger.value = saved.commandTrigger;
    mentionTrigger.value = saved.mentionTrigger;
    triggerSettingsMessage.value = t("settings.composer.saved");
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
  } catch (error) {
    triggerSettingsMessage.value = errorText(error);
    triggerSettingsMessageError.value = true;
    showControlPlaneToast(triggerSettingsMessage.value);
  } finally {
    savingTriggerSettings.value = false;
  }
}

function validCommandTrigger(value: string) {
  return Array.from(value).length === 1 && !/[\p{L}\p{N}\s\\]/u.test(value) && value !== mentionTrigger.value;
}

async function refreshChat() {
  await invalidateControlPlaneDomains(queryClient, ["chat"]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function nodeAgent(nodeId: string) {
  const checkedAgent = asRecord(nodeStatusById[nodeId]?.agent);
  if (checkedAgent) {
    return checkedAgent;
  }
  const node = (nodes.data.value || []).find((item) => item.id === nodeId);
  return asRecord(node?.capabilities["agent"]);
}

function nodeBuild(nodeId: string): Partial<BuildInfo> | undefined {
  return asRecord(nodeAgent(nodeId)?.build) as Partial<BuildInfo> | undefined;
}

function nodeProtocolLabel(nodeId: string) {
  const protocolVersion = nodeAgent(nodeId)?.protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion ? protocolVersion : nodeBuild(nodeId)?.protocolVersion || t("common.status.unknown");
}

function nodeBuildLabel(nodeId: string) {
  const build = nodeBuild(nodeId);
  return build?.buildId || build?.gitCommit?.slice(0, 12) || t("common.status.unknown");
}

function nodePackageLabel(nodeId: string) {
  return nodeBuild(nodeId)?.packageVersion || t("common.status.unknown");
}

function nodeEventTransport(nodeId: string): NodeAgentEventTransportHealth | undefined {
  const value = asRecord(nodeAgent(nodeId)?.eventTransport);
  if (!value || !["healthy", "congested", "recovering"].includes(String(value.status))) return undefined;
  return value as NodeAgentEventTransportHealth;
}

function nodeBuildTitle(nodeId: string) {
  const build = nodeBuild(nodeId);
  return [
    `${t("settings.nodeDetail.protocol")}: ${nodeProtocolLabel(nodeId)}`,
    `${t("settings.nodeDetail.build")}: ${nodeBuildLabel(nodeId)}`,
    `${t("settings.nodeDetail.package")}: ${nodePackageLabel(nodeId)}`,
    build?.imageRef ? `${t("settings.nodeDetail.image")}: ${build.imageRef}` : undefined,
    build?.builtAt ? `${t("settings.nodeDetail.built")}: ${build.builtAt}` : undefined,
  ].filter(Boolean).join("\n");
}

function nodeRuntimeSummary(nodeId: string) {
  const count = nodeRuntimeItems.value.filter((runtime) => runtime.nodeId === nodeId).length;
  return t("settings.nodeDetail.runtimeCount", { count });
}

function nodeInstanceSummary(nodeId: string) {
  const instances = boardItems.value.filter((instance) => instance.nodeId === nodeId);
  const running = instances.filter((instance) => instance.status === "running").length;
  return t("settings.nodeDetail.runningCount", { running, total: instances.length });
}

function nodeStatusValue(nodeId: string) {
  const node = (nodes.data.value || []).find((item) => item.id === nodeId);
  if (nodeEventTransport(nodeId)?.status === "congested") return "degraded";
  return nodeStatusById[nodeId]?.status || node?.status || "unknown";
}

function nodeStatusLabel(nodeId: string) {
  return translateStatus(connectionStatusKeys, nodeStatusValue(nodeId), t);
}

function nodeStatusVariant(nodeId: string) {
  return nodeStatusValue(nodeId) === "online" ? "default" : "secondary";
}

function nodeStatusClass(nodeId: string) {
  return `status-${nodeStatusValue(nodeId)}`;
}

function refreshNodeConnectionDiagnostics(open: boolean, nodeId?: string) {
  if (!open) return;
  if (nodeId) void checkSettingsNode(nodeId);
  else void nodes.refetch();
}

function updateRemoteConnect(field: "controlPlaneUrl" | "joinToken" | "controlPlaneName", value: string) {
  remoteConnect[field] = value;
}

function errorText(error: unknown) {
  const fallback = error instanceof Error ? error.message : String(error);
  return translateApiError(error, t, fallback);
}
</script>

<style scoped>
.control-settings-page {
  --settings-content-max-width: 1080px;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  align-items: start;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  gap: 18px;
  background: var(--control-plane-settings-background,
    radial-gradient(circle at 62% -10%, var(--brand-accent-soft), transparent 28rem),
    var(--surface-inset));
  color: var(--text);
  padding: 18px;
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.settings-section-scroll {
  align-self: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.settings-section-scroll :deep([data-task-handoff-scroll-viewport] > div) {
  min-width: 100%;
  min-height: 100%;
}

.settings-section-scroll-content {
  min-width: 0;
  padding: 0 10px 18px 0;
}

.settings-content-column {
  margin: 0 auto;
  width: min(100%, var(--settings-content-max-width));
}

.control-settings-page-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
  gap: 10px;
}

.control-settings-tabs,
.source-toggle {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  height: 32px;
  min-height: 32px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 2px;
}

.control-settings-tabs {
  align-self: start;
  gap: 1px;
}

.control-settings-tabs button,
.source-toggle button {
  height: 26px;
  min-height: 26px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 750;
  padding: 0 10px;
}

.source-toggle button {
  min-height: 26px;
  padding: 0 9px;
}

.control-settings-tabs button:hover,
.control-settings-tabs button:focus-visible,
.control-settings-tabs button[data-state="active"],
.source-toggle button:hover,
.source-toggle button:focus-visible,
.source-toggle button.active {
  background: var(--surface-active);
  color: var(--text-strong);
  outline: none;
}

.node-management-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.78fr) minmax(0, 1.22fr);
  align-items: start;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.node-list-panel,
.node-detail-panel {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}

.node-list-panel {
  grid-template-rows: auto auto minmax(0, 1fr);
}

.node-list {
  min-height: 0;
  padding-right: 2px;
}

.settings-scroll-content {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 100%;
  padding-right: 2px;
}

.node-list-item {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: inherit;
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.node-list-item:hover,
.node-list-item:focus-visible,
.node-list-item.active {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  outline: none;
}

.node-list-item > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.node-list-item strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-list-item small,
.node-list-item code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--text-subtle);
  margin-top: 4px;
  box-shadow: 0 0 0 3px var(--surface-subtle);
}

.node-status-dot.status-online {
  background: var(--status-success);
  box-shadow: 0 0 0 3px var(--brand-accent-soft);
}

.node-status-dot.status-offline,
.node-status-dot.status-failed {
  background: var(--status-danger);
  box-shadow: 0 0 0 3px var(--status-danger-bg);
}

.node-list-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  grid-column: 2;
  min-width: 0;
}

.node-diagnostic-badge {
  display: inline-flex;
  cursor: help;
  outline: none;
}

:global(.node-diagnostic-tooltip) {
  min-width: 230px;
  max-width: min(360px, 80vw);
  border: 1px solid var(--line-strong) !important;
  background: var(--surface-inset) !important;
  color: var(--text) !important;
  box-shadow: var(--shadow-popover);
}

:global(.node-diagnostic-tooltip-grid) {
  display: grid;
  gap: 7px;
}

:global(.node-diagnostic-tooltip-grid span) {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

:global(.node-diagnostic-tooltip-grid b),
:global(.node-diagnostic-tooltip-grid em) {
  overflow: hidden;
  font-size: 11px;
  font-style: normal;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.node-diagnostic-tooltip-grid b) {
  color: var(--text-muted) !important;
  font-weight: 750;
}

:global(.node-diagnostic-tooltip-grid em) {
  color: var(--text-strong) !important;
  font-weight: 650;
}

.node-list-connection-diagnostics {
  margin-top: 9px;
  border-top: 1px solid var(--line-subtle);
  padding-top: 9px;
}

:global(.node-add-menu) {
  width: 280px;
}

:global(.node-add-menu-item) {
  align-items: flex-start !important;
  gap: 10px !important;
  min-height: 50px;
  padding: 8px 10px !important;
}

:global(.node-add-menu-item > svg) {
  flex: 0 0 auto;
  margin-top: 2px;
}

:global(.node-add-menu-item > span) {
  display: grid;
  flex: 1 1 auto;
  gap: 2px;
  min-width: 0;
}

:global(.node-onboarding-menu-badge) {
  flex: 0 0 auto;
  align-self: center;
  white-space: nowrap;
}

:global(.node-add-menu-item strong),
:global(.node-add-menu-item small) {
  overflow: hidden;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.node-add-menu-item strong) {
  color: inherit;
  font-size: 12px;
  font-weight: 750;
}

:global(.node-add-menu-item small) {
  color: var(--text-muted);
  font-size: 11px;
}

.remote-node-dialog {
  width: min(520px, calc(100vw - 36px));
  max-height: calc(100dvh - 36px);
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
}

:global(.node-rename-dialog.node-rename-dialog) {
  width: min(460px, calc(100vw - 36px)) !important;
}

.node-rename-form {
  display: grid;
  gap: 10px;
}

.node-rename-form > label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.node-rename-form .control-plane-error {
  margin: 0;
}

.remote-node-form {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 14px;
  min-height: 0;
}

.remote-node-form-scroll { min-height: 0; }
.remote-node-form-content { display: grid; gap: 14px; padding-right: 10px; }

.remote-node-form label,
.remote-node-field {
  display: grid;
  gap: 7px;
}

.remote-node-form label > span,
.remote-node-field > label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.remote-node-mode-tabs { width: 100%; }
.remote-node-mode-tabs :deep(button) { flex: 1; }
.remote-node-mode-content { display: grid; gap: 12px; margin-top: 12px; }
.proxy-token-input { position: relative; }
.proxy-token-input .control-plane-input { padding-right: 40px; }
.proxy-token-input button { position: absolute; top: 1px; right: 1px; width: 32px; height: 32px; }
.proxy-trust-notice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-inset); font-size: 12px; line-height: 1.5; }
.proxy-trust-notice svg { flex: none; color: var(--warning, var(--text-muted)); }
.proxy-trust-confirmation { grid-template-columns: auto minmax(0, 1fr) !important; align-items: start; color: var(--text); font-size: 12px; line-height: 1.5; }
.pending-proxy-state, .pending-proxy-claims { font-size: 12px; }
.pending-proxy-state { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pending-proxy-claims { display: grid; gap: 6px; min-height: 0; border: 1px solid var(--status-warning); border-radius: 7px; background: var(--status-warning-bg); padding: 9px; }
.pending-proxy-heading { display: flex; align-items: center; gap: 6px; color: var(--text-strong); }
.pending-proxy-claims > p { margin: 0; color: var(--text-muted); }
.pending-proxy-list { max-height: min(180px, max(88px, calc(100dvh - 480px))); }
.pending-proxy-list-content { min-width: 0; padding-right: 10px; }
.pending-proxy-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.pending-proxy-row > span { min-width: 0; overflow-wrap: anywhere; }
.pending-proxy-row > div { display: flex; gap: 6px; }
.proxy-spin { animation: proxy-spin 0.8s linear infinite; }
@keyframes proxy-spin { to { transform: rotate(360deg); } }

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.section-head > span,
.modal-section label span,
.project-model-picker > span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.section-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head .inline-flex {
  flex: 0 0 auto;
}

.section-head button:not(.inline-flex) {
  border: 0;
  background: transparent;
  color: var(--status-success);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0;
}

.section-head button:not(.inline-flex):hover,
.section-head button:not(.inline-flex):focus-visible {
  color: var(--brand-accent);
  outline: none;
}

.local-image-list {
  min-height: 0;
}

.local-image-list {
  max-height: min(470px, calc(100vh - 330px));
}

.runtime-image-panel {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--line);
  margin-top: 12px;
  padding-top: 12px;
}

.local-image-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 9px;
}

.settings-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
}

.local-image-row > div:first-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.local-image-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.local-image-row span,
.image-meta-line {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-meta-line {
  line-height: 1.35;
}


.checkbox-row,
.project-model-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.modal-section .checkbox-row label {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px;
}

.modal-section .checkbox-row label:hover,
.modal-section .checkbox-row label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.modal-section .checkbox-row label:has([data-state="checked"]) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.project-model-picker label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px 0 34px;
}

.project-model-picker input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  margin: 0;
}

.project-model-picker label::before {
  position: absolute;
  left: 11px;
  top: 50%;
  display: grid;
  width: 15px;
  height: 15px;
  place-items: center;
  border: 1px solid var(--text-subtle);
  border-radius: 4px;
  background: var(--surface-inset);
  color: transparent;
  content: "";
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
  transform: translateY(-50%);
}

.project-model-picker label:hover,
.project-model-picker label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.project-model-picker label:has(input:focus-visible) {
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.project-model-picker label:has(input:checked) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.project-model-picker label:has(input:checked)::before {
  border-color: var(--brand-accent);
  background: var(--brand-accent);
  color: var(--surface-inset);
  content: "✓";
}

.project-model-picker {
  margin-top: 5px;
}

.project-model-picker small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.project-model-picker.create-picker {
  display: flex;
  margin-top: 0;
}

.modal-section label,
.inline-create {
  display: grid;
  gap: 7px;
}

.inline-create {
  gap: 9px;
}

.inline-create label > small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}

.settings-empty,
.settings-success,
.control-plane-error {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
}

.settings-empty {
  color: var(--text-muted);
}

.settings-success {
  color: var(--status-success);
}

.control-plane-error {
  color: var(--status-danger);
}

.modal-section .list-filter {
  display: flex;
  grid-template-columns: none;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: var(--text-muted);
  padding: 0 9px;
}

.modal-section .list-filter input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font-size: 13px;
  outline: none;
}

.modal-section .list-filter input::placeholder {
  color: var(--text-subtle);
}

.modal-section .local-image-filter {
  margin-bottom: 0;
}

.modal-section .local-image-filter ~ .control-plane-error,
.modal-section .local-image-filter ~ .settings-success,
.modal-section .local-image-filter ~ .local-image-list {
  margin-top: 2px;
}

@media (max-width: 780px) {
  .node-management-grid {
    grid-template-columns: 1fr;
  }

  .control-settings-page {
    padding: 12px;
  }

  .settings-section-scroll-content {
    padding-right: 6px;
  }

}
</style>
<style src="./SettingsPanelSurface.css"></style>
