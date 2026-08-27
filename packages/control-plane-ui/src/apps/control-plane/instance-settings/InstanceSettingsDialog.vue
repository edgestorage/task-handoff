<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="instance-settings-dialog" aria-describedby="instance-settings-description">
      <DialogHeader class="instance-settings-header">
        <div class="instance-settings-heading">
          <span>{{ t("instances.settings.eyebrow") }}</span>
          <div class="instance-settings-title-row">
            <DialogTitle>{{ instance?.name || t("instances.settings.unavailableTitle") }}</DialogTitle>
            <Badge v-if="instance" :variant="instance.connectionStatus === 'online' ? 'default' : 'secondary'">
              {{ instanceStatusLabel(instance.status) }} · {{ connectionStatusLabel(instance.connectionStatus) }}
            </Badge>
          </div>
          <DialogDescription id="instance-settings-description">
            {{ t("instances.settings.description") }}
          </DialogDescription>
        </div>
        <button type="button" class="instance-settings-close" :aria-label="t('instances.settings.close')" @click="handleOpenChange(false)">
          <X :size="16" />
        </button>
      </DialogHeader>

      <div v-if="!instance" class="instance-settings-empty">{{ t("instances.settings.unavailable") }}</div>
      <Tabs v-else v-model="section" class="instance-settings-tabs">
        <TabsList class="instance-settings-tabs-list" :aria-label="t('instances.settings.sections')">
          <TabsTrigger value="general"><SlidersHorizontal :size="14" />{{ t("instances.settings.general") }}</TabsTrigger>
          <TabsTrigger value="models"><Cpu :size="14" />{{ t("instances.settings.models") }}</TabsTrigger>
          <TabsTrigger value="git-credentials"><KeyRound :size="14" />{{ t("instances.settings.gitCredentials") }}</TabsTrigger>
          <TabsTrigger value="apps"><Boxes :size="14" />{{ t("instances.settings.apps") }}</TabsTrigger>
        </TabsList>

        <ScrollArea class="instance-settings-scroll">
          <TabsContent value="general" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.detailsTitle") }}</h3>
                <p>{{ t("instances.settings.detailsDescription") }}</p>
              </div>
              <dl class="instance-settings-grid instance-settings-surface">
                <div><dt>{{ t("instances.settings.id") }}</dt><dd><code>{{ instance.id }}</code></dd></div>
                <div><dt>{{ t("instances.settings.state") }}</dt><dd>{{ instanceStatusLabel(instance.status) }} · {{ connectionStatusLabel(instance.connectionStatus) }}</dd></div>
                <div><dt>{{ t("instances.settings.node") }}</dt><dd>{{ instance.node?.name || instance.nodeId }}</dd></div>
                <div><dt>{{ t("instances.settings.runtime") }}</dt><dd>{{ instance.runtime?.name || instance.runtimeId }}</dd></div>
                <div><dt>{{ t("instances.settings.image") }}</dt><dd>{{ instance.image?.name || instance.imageSelection?.imageId || t("instances.settings.none") }}</dd></div>
                <div><dt>{{ t("instances.settings.workspace") }}</dt><dd>{{ instance.workspace.path || instance.runtime?.workspacePath || t("instances.settings.notReported") }} · {{ instance.workspace.status }}</dd></div>
                <div><dt>{{ t("instances.settings.protocol") }}</dt><dd>{{ instance.protocolVersion || instance.build?.protocolVersion || t("instances.settings.notReported") }}</dd></div>
                <div><dt>{{ t("instances.settings.build") }}</dt><dd>{{ instance.build?.packageVersion || instance.instanceVersion || t("instances.settings.notReported") }}</dd></div>
              </dl>
            </section>

            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.configurationTitle") }}</h3>
                <p>{{ t("instances.settings.configurationDescription") }}</p>
              </div>
              <div class="instance-settings-control-surface instance-settings-surface">
                <div class="instance-settings-general-controls">
                  <label class="instance-settings-name-control">
                    <span>
                      <strong>{{ t("instances.settings.instanceName") }}</strong>
                      <small>{{ t("instances.settings.instanceNameDescription") }}</small>
                    </span>
                    <ControlPlaneInput v-model="instanceName" :disabled="savingGeneral" maxlength="160" :placeholder="t('instances.settings.instanceName')" />
                  </label>
                  <label class="instance-settings-name-control">
                    <span>
                      <strong>{{ t("instances.settings.aiSessionFileAttachmentLimit") }}</strong>
                      <small>{{ fileAttachmentLimitSupported ? t("instances.settings.aiSessionFileAttachmentLimitDescription") : t("instances.settings.aiSessionFileAttachmentLimitUnsupported") }}</small>
                    </span>
                    <ControlPlaneInput
                      v-model="aiSessionMaxFileAttachmentKiB"
                      type="number"
                      min="1"
                      :max="AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES / 1024"
                      step="1"
                      :disabled="savingGeneral || !fileAttachmentLimitSupported"
                    />
                  </label>
                  <label class="instance-settings-name-control">
                    <span>
                      <strong>{{ t("instances.settings.aiSessionAttachmentRetention") }}</strong>
                      <small>{{ attachmentRetentionSupported ? t("instances.settings.aiSessionAttachmentRetentionDescription") : t("instances.settings.aiSessionAttachmentRetentionUnsupported") }}</small>
                    </span>
                    <ControlPlaneInput
                      v-model="aiSessionAttachmentRetentionDays"
                      type="number"
                      min="0"
                      :max="AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS"
                      step="1"
                      :disabled="savingGeneral || !attachmentRetentionSupported"
                    />
                  </label>
                  <p v-if="attachmentRetentionWillShorten" class="instance-settings-help instance-settings-row-note">{{ t("instances.settings.aiSessionAttachmentRetentionWarning") }}</p>
                  <label class="instance-settings-checkbox">
                    <Checkbox :model-value="autoImportAgentConfigs" :disabled="savingGeneral" @update:model-value="autoImportAgentConfigs = $event === true" />
                    <span>
                      <strong>{{ t("instances.settings.autoImport") }}</strong>
                      <small>{{ t("instances.settings.autoImportDescription") }}</small>
                    </span>
                  </label>
                  <label class="instance-settings-select-control">
                    <span>
                      <strong>{{ t("instances.settings.sessionPermissions") }}</strong>
                      <small>{{ t("instances.settings.sessionPermissionsDescription") }}</small>
                    </span>
                    <ControlPlaneSelect v-model="defaultCodexPermissionMode" :disabled="savingGeneral">
                      <ControlPlaneSelectItem value="ask">{{ t("instances.settings.askApproval") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="auto-review">{{ t("instances.settings.approveForMe") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="full-access">{{ t("instances.settings.fullAccess") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label class="instance-settings-name-control">
                    <span>
                      <strong>{{ t("instances.settings.aiSessionHistoryLimit") }}</strong>
                      <small>{{ historyLimitSupported ? t("instances.settings.aiSessionHistoryLimitDescription") : t("instances.settings.aiSessionHistoryLimitUnsupported") }}</small>
                    </span>
                    <ControlPlaneInput
                      v-model="aiSessionHistoryLimit"
                      type="number"
                      min="1"
                      :max="AI_SESSION_HISTORY_MAX_LIMIT"
                      step="1"
                      :disabled="savingGeneral || !historyLimitSupported"
                    />
                  </label>
                </div>
                <div class="instance-settings-general-actions">
                  <Button size="sm" :disabled="savingGeneral || !generalChanged || !validInstanceName || !validHistoryLimit || !validAttachmentRetention || !validFileAttachmentLimit" @click="saveGeneral">
                    {{ savingGeneral ? t("instances.settings.saving") : t("instances.settings.saveChanges") }}
                  </Button>
                </div>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="models" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.modelSelection") }}</h3>
                <p>{{ t("instances.settings.modelSelectionDescription") }}</p>
              </div>
              <div class="instance-model-surface instance-settings-surface">
                <ModelEntitySelection v-model="modelEntityIds" :models="models" :node-id="instance?.nodeId || ''" :disabled="savingModels" />
                <div class="instance-settings-general-actions">
                  <Button size="sm" :disabled="savingModels || !modelsChanged" @click="saveModels">
                    {{ savingModels ? t("instances.settings.saving") : t("instances.settings.saveModels") }}
                  </Button>
                </div>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="git-credentials" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-settings-section-heading">
                <h3>{{ t("instances.settings.gitCredentialsTitle") }}</h3>
                <p>{{ t("instances.settings.gitCredentialsDescription") }}</p>
              </div>
              <div class="instance-git-directory instance-settings-surface">
                <div v-if="!gitBrokerSupported" class="instance-settings-state">{{ t("instances.settings.gitCredentialsUnsupported") }}</div>
                <div v-else-if="gitAssignments.error.value || gitCredentials.error.value" class="instance-settings-state instance-settings-state-error" role="alert">
                  <span>{{ gitCredentialError }}</span>
                  <Button size="sm" variant="outline" @click="refreshGitCredentials">{{ t("instances.settings.retry") }}</Button>
                </div>
                <template v-else>
                  <div v-if="gitCredentialMatchText" class="instance-git-match-preview" :data-status="gitCredentialMatchStatus">
                    <Globe2 :size="15" />
                    <span>{{ gitCredentialMatchText }}</span>
                    <Badge variant="secondary">{{ t(`instances.settings.gitCredentialMatchStatus.${gitCredentialMatchStatus}`) }}</Badge>
                  </div>
                  <div class="instance-git-assignment-create">
                    <ControlPlaneSelect v-model="selectedGitCredentialId" :placeholder="t('instances.settings.selectGitCredential')" :disabled="gitCredentialBusy">
                      <ControlPlaneSelectItem :value="noGitCredentialValue">{{ t("instances.settings.selectGitCredential") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem v-for="credential in assignableGitCredentials" :key="credential.id" :value="credential.id">{{ credential.name }} · {{ credential.scope.host }}{{ credential.scope.pathPrefix }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                    <Button size="sm" :disabled="!selectedGitCredentialId || selectedGitCredentialId === noGitCredentialValue || gitCredentialBusy" @click="authorizeGitCredential">
                      <KeyRound :size="14" />
                      {{ t("instances.settings.authorizeGitCredential") }}
                    </Button>
                  </div>
                  <div v-if="gitAssignments.isLoading.value" class="instance-settings-state">{{ t("instances.settings.gitCredentialsLoading") }}</div>
                  <div v-else-if="!gitAssignments.data.value?.length" class="instance-settings-state instance-settings-empty-state">
                    <KeyRound :size="26" aria-hidden="true" />
                    <span>{{ t("instances.settings.noGitCredentials") }}</span>
                  </div>
                  <div v-else class="instance-app-list instance-directory-list">
                    <article v-for="assignment in gitAssignments.data.value" :key="assignment.credentialId" class="instance-app-row instance-git-assignment-row">
                      <div class="instance-directory-identity">
                        <span class="instance-app-icon" aria-hidden="true"><KeyRound :size="16" /></span>
                        <div>
                          <strong>{{ gitCredentialName(assignment.credentialId) }}</strong>
                          <code>{{ gitCredentialScope(assignment.credentialId) }}</code>
                        </div>
                      </div>
                      <div class="instance-git-assignment-actions">
                        <Badge :variant="assignment.status === 'synced' ? 'default' : 'secondary'">{{ t(`instances.settings.gitCredentialStatus.${assignment.status}`) }}</Badge>
                        <Button size="sm" variant="outline" :disabled="gitCredentialBusy" @click="revokeGitCredential(assignment.credentialId)">{{ t("instances.settings.revokeGitCredential") }}</Button>
                      </div>
                    </article>
                  </div>
                </template>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="apps" class="instance-settings-section">
            <section class="instance-settings-card instance-settings-group">
              <div class="instance-app-heading">
                <div class="instance-settings-section-heading">
                  <h3>{{ t("instances.settings.managedApps") }}</h3>
                  <p>{{ t("instances.settings.managedAppsDescription") }}</p>
                </div>
                <div v-if="appManagement" class="instance-app-heading-actions">
                  <Badge variant="secondary">{{ appManagement.capabilities.platform }} · {{ appManagement.capabilities.arch }}</Badge>
                  <Button size="icon" variant="ghost" :aria-label="t('instances.settings.refreshApps')" :disabled="appManagementLoading" @click="refreshApps">
                    <RefreshCw :class="{ 'animate-spin motion-reduce:animate-none': appManagementLoading }" :size="14" />
                  </Button>
                </div>
              </div>
              <p v-if="appManagement" class="instance-settings-observed">{{ t("instances.settings.observed", { time: formatObservedAt(appManagement.observedAt), privilege: appManagement.capabilities.privilege }) }}</p>
              <div class="instance-app-directory instance-settings-surface">
                <div v-if="appManagementLoading && !appManagement" class="instance-settings-state">{{ t("instances.settings.appsLoading") }}</div>
                <div v-else-if="appManagementError" class="instance-settings-state instance-settings-state-error" role="alert">
                  <span>{{ t("instances.settings.appsUnavailable") }} · {{ appManagementError }}</span>
                  <Button size="sm" variant="outline" @click="refreshApps">{{ t("instances.settings.retry") }}</Button>
                </div>
                <div v-else-if="!appManagement" class="instance-settings-state">{{ t("instances.settings.noSnapshot") }}</div>
                <div v-else-if="!appManagement.apps.length" class="instance-settings-state instance-settings-empty-state">{{ t("instances.settings.noManagedApps") }}</div>
                <template v-else>
                <div class="instance-app-toolbar" :aria-label="t('instances.settings.appFilters')">
                  <div class="instance-app-filters">
                    <Button v-for="filter in appFilters" :key="filter.value" size="sm" :variant="appFilter === filter.value ? 'secondary' : 'ghost'" :aria-pressed="appFilter === filter.value" @click="appFilter = filter.value">
                      {{ filter.label }} <span>{{ filter.count }}</span>
                    </Button>
                  </div>
                  <small>{{ installableAppCount ? t("instances.settings.readyToInstall", { count: installableAppCount }) : t("instances.settings.noInstalls") }}</small>
                </div>
                <div v-if="!filteredManagedApps.length" class="instance-settings-state">{{ t("instances.settings.noFilterMatches") }}</div>
                <div v-else class="instance-app-list instance-directory-list">
                  <article v-for="app in filteredManagedApps" :key="app.id" class="instance-app-row instance-managed-app-row">
                    <div class="instance-app-main">
                      <div class="instance-app-identity">
                        <span class="instance-app-icon" aria-hidden="true">
                          <AiAgentIcon v-if="app.id === 'codex' || app.id === 'claude'" :agent="app.id" :size="17" />
                          <component :is="managedAppIcon(app)" v-else :size="17" />
                        </span>
                        <div class="instance-app-copy">
                          <strong>{{ app.name }}</strong>
                          <small v-if="app.description">{{ app.description }}</small>
                          <code>{{ app.id }} · {{ app.kind }}<template v-if="app.version"> · {{ app.version }}</template></code>
                          <small v-if="appActionHint(app)" class="instance-app-action-reason">{{ appActionHint(app) }}</small>
                        </div>
                      </div>
                      <div class="instance-app-controls">
                        <Badge :variant="managedAppBadgeVariant(app.state)">{{ managedAppStateLabel(app.state) }}</Badge>
                        <Button v-if="activeJob(app)" size="sm" disabled>
                          <LoaderCircle class="animate-spin motion-reduce:animate-none" :size="13" />
                          {{ activeJob(app)?.operation === "install" ? t("instances.settings.installing") : t("instances.settings.uninstalling") }}
                        </Button>
                        <Button v-else-if="app.canInstall" size="sm" :disabled="operationSubmitting === app.id" @click="openAppConfirmation(app, 'install')">{{ t("instances.settings.install") }}</Button>
                        <Button v-else-if="app.canUninstall" size="sm" variant="destructive" :disabled="operationSubmitting === app.id" @click="openAppConfirmation(app, 'uninstall')">{{ t("instances.settings.uninstall") }}</Button>
                      </div>
                    </div>
                    <div v-if="activeJob(app) || executionJob(app)?.command || executionJob(app)?.logTail || terminalJob(app)" class="instance-app-activity">
                      <small v-if="activeJob(app)" class="instance-app-job-line">{{ jobLabel(activeJob(app)!) }}</small>
                      <Progress v-if="progressPercent(activeJob(app)) !== undefined" :model-value="progressPercent(activeJob(app))" class="instance-app-progress" />
                      <details v-if="executionJob(app)?.command || executionJob(app)?.logTail" class="instance-app-terminal" :open="Boolean(activeJob(app))">
                        <summary>{{ activeJob(app) ? t("instances.settings.liveInstallerOutput") : t("instances.settings.installerOutput") }}<template v-if="executionJob(app)?.logTruncated"> · {{ t("instances.settings.latestLog") }}</template></summary>
                        <pre aria-live="polite">{{ executionOutput(executionJob(app)!) }}</pre>
                      </details>
                      <small v-if="terminalJob(app)" :class="terminalJob(app)?.state === 'succeeded' ? 'instance-settings-success' : 'instance-settings-error'" role="status">
                        {{ terminalJobLabel(terminalJob(app)!) }}<template v-if="terminalJob(app)?.error"> · {{ terminalJob(app)?.error?.message }}</template><template v-if="terminalJob(app)?.error?.retryable"> {{ t("instances.settings.retryDetected") }}</template>
                      </small>
                    </div>
                  </article>
                </div>
                </template>
              </div>
            </section>

            <section class="instance-settings-card instance-settings-group">
              <div class="instance-app-heading">
                <div class="instance-settings-section-heading">
                  <h3>{{ t("instances.settings.customLaunchers") }}</h3>
                  <p>{{ t("instances.settings.customLaunchersDescription") }}</p>
                </div>
                <Badge :variant="inventoryBadgeVariant">{{ inventoryStateLabel }}</Badge>
              </div>
              <p v-if="instance.appInventory" class="instance-settings-observed">{{ t("instances.settings.inventoryObserved", { time: formatObservedAt(instance.appInventory.observedAt) }) }}</p>
              <div class="instance-app-directory instance-settings-surface">
                <div v-if="!customInventoryApps.length" class="instance-settings-state instance-settings-empty-state">{{ t("instances.settings.noCustomLaunchers") }}</div>
                <div v-else class="instance-app-list instance-directory-list">
                  <article v-for="app in customInventoryApps" :key="app.id" class="instance-app-row instance-custom-app-row">
                    <div class="instance-directory-identity">
                      <span class="instance-app-icon" aria-hidden="true"><Boxes :size="16" /></span>
                      <div><strong>{{ app.name }}</strong><code>{{ app.id }} · {{ app.kind }}</code><small v-if="app.diagnosticCode">{{ t("instances.settings.executableMissing") }}</small></div>
                    </div>
                    <Badge :variant="app.availability === 'available' ? 'default' : 'secondary'">{{ app.availability }}</Badge>
                  </article>
                </div>
                <div v-if="instance.appInventory?.issues.length" class="instance-app-issues" role="status">
                  <strong>{{ t("instances.settings.inventoryDiagnostics") }}</strong>
                  <p v-for="issue in instance.appInventory.issues" :key="issue.code">{{ issue.message }} <code>{{ issue.code }}</code></p>
                </div>
              </div>
            </section>
          </TabsContent>
        </ScrollArea>
      </Tabs>

      <p v-if="error" class="instance-settings-error" role="alert">{{ error }}</p>
      <p v-if="success" class="instance-settings-success" role="status">{{ success }}</p>

      <AlertDialog :open="Boolean(appConfirmation)" @update:open="(value) => { if (!value && !operationSubmitting) appConfirmation = undefined; }">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("instances.settings.operationQuestion", { operation: appConfirmation?.operation === "uninstall" ? t("instances.settings.uninstall") : t("instances.settings.install"), name: appConfirmation?.app.name }) }}</AlertDialogTitle>
            <AlertDialogDescription v-if="appConfirmation?.operation === 'uninstall'">
              {{ t("instances.settings.uninstallDescription") }}
            </AlertDialogDescription>
            <AlertDialogDescription v-else>
              {{ t("instances.settings.installDescription") }}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div v-if="appConfirmation" class="instance-app-confirmation-summary">
            <span><small>{{ t("instances.settings.app") }}</small><strong>{{ appConfirmation.app.name }}</strong></span>
            <span><small>{{ t("instances.settings.target") }}</small><strong>{{ instance?.name }}</strong></span>
            <span><small>{{ t("instances.settings.privilege") }}</small><strong>{{ appManagement?.capabilities.privilege || t("instances.settings.notReported") }}</strong></span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel :disabled="Boolean(operationSubmitting)">{{ t("instances.settings.cancel") }}</AlertDialogCancel>
            <Button type="button" :disabled="Boolean(operationSubmitting)" @click="confirmAppOperation">
              <LoaderCircle v-if="operationSubmitting" class="animate-spin motion-reduce:animate-none" :size="14" />
              {{ operationSubmitting ? t("instances.settings.queuing") : appConfirmation?.operation === "uninstall" ? t("instances.settings.confirmUninstall") : t("instances.settings.confirmInstall") }}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Boxes, Cpu, Globe2, KeyRound, LoaderCircle, Monitor, RefreshCw, SlidersHorizontal, TerminalSquare, X } from "@lucide/vue";
import { AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS, AI_SESSION_HISTORY_MAX_LIMIT, AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES, type AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import { supportsAiSessionFileSizeLimitSettings, supportsGitCredentialProxy, supportsNodeAiSessionFileAttachmentLimit } from "@task-handoff/protocol/control-plane";
import { resolveGitCredential, type GitCredentialPublic } from "@task-handoff/protocol/managed-git-credentials";
import type { AppManagementJob, AppManagementOperation, AppManagementSnapshot, InstanceBoardItem, ManagedAppProjection, ModelConfig, ModelSelection, UpdateControlledInstanceInput } from "../../../api/types";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import AiAgentIcon from "../../../components/AiAgentIcon.vue";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Progress } from "../../../components/ui/progress";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ModelEntitySelection from "../../../components/models/ModelEntitySelection.vue";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";
import { connectionStatusKeys, instanceStatusKeys, translateStatus } from "../../../i18n/status";
import { translateApiError } from "../../../i18n/apiError";
import { authorizeInstanceGitCredential, revokeInstanceGitCredential, useGitCredentialsQuery, useInstanceGitCredentialAssignmentsQuery } from "../../../api/queries";

const { t } = useI18n();
const { locale } = useControlPlaneLocale();
const instanceStatusLabel = (status: string) => translateStatus(instanceStatusKeys, status, t);
const connectionStatusLabel = (status: string) => translateStatus(connectionStatusKeys, status, t);

type InstanceSettingsSection = "general" | "models" | "git-credentials" | "apps";
type AppFilter = "all" | "available" | "installed";

const props = defineProps<{
  open: boolean;
  initialSection?: InstanceSettingsSection;
  instance?: InstanceBoardItem;
  models: ModelConfig[];
  appManagement?: AppManagementSnapshot;
  appManagementLoading: boolean;
  appManagementError: string;
  refreshAppManagement: (instanceId: string) => Promise<void>;
  manageApp: (instanceId: string, appId: string, operation: AppManagementOperation) => Promise<void>;
  updateInstance: (instance: InstanceBoardItem, input: UpdateControlledInstanceInput) => Promise<void>;
}>();

const emit = defineEmits<{ "update:open": [open: boolean] }>();
const section = ref<InstanceSettingsSection>("general");
const instanceName = ref("");
const autoImportAgentConfigs = ref(true);
const defaultCodexPermissionMode = ref<AiSessionPermissionMode>("ask");
const aiSessionHistoryLimit = ref("50");
const aiSessionAttachmentRetentionDays = ref("30");
const aiSessionMaxFileAttachmentKiB = ref("500");
const modelSelection = ref<ModelSelection>({});
const savingGeneral = ref(false);
const savingModels = ref(false);
const error = ref("");
const success = ref("");
const operationSubmitting = ref("");
const appConfirmation = ref<{ app: ManagedAppProjection; operation: AppManagementOperation }>();
const appFilter = ref<AppFilter>("all");
const noGitCredentialValue = "__none__";
const selectedGitCredentialId = ref(noGitCredentialValue);
const gitCredentialBusy = ref(false);
const gitBrokerSupported = computed(() => Boolean(props.instance && supportsGitCredentialProxy(props.instance.capabilities)));
const gitCredentials = useGitCredentialsQuery(computed(() => props.open && section.value === "git-credentials" && gitBrokerSupported.value));
const gitAssignments = useInstanceGitCredentialAssignmentsQuery(computed(() => props.instance?.id || ""), computed(() => props.open && section.value === "git-credentials" && gitBrokerSupported.value));
const assignedGitCredentialIds = computed(() => new Set((gitAssignments.data.value || []).map((assignment) => assignment.credentialId)));
const assignableGitCredentials = computed(() => (gitCredentials.data.value || []).filter((credential) => credential.status === "enabled" && !assignedGitCredentialIds.value.has(credential.id)));
const gitCredentialError = computed(() => translateApiError(gitAssignments.error.value || gitCredentials.error.value, t, t("instances.settings.gitCredentialsLoadFailed")));
const gitCredentialMatch = computed(() => {
  const source = props.instance?.source;
  if (!source || source.type === "local-folder") return undefined;
  const syncedIds = new Set((gitAssignments.data.value || [])
    .filter((assignment) => assignment.status === "synced")
    .map((assignment) => assignment.credentialId));
  return resolveGitCredential(source.url, (gitCredentials.data.value || [])
    .filter((credential) => syncedIds.has(credential.id))
    .map((credential) => ({
      id: credential.id,
      kind: credential.kind,
      scope: credential.scope,
      status: credential.status,
      pinnedKnownHosts: credential.kind === "ssh-key",
    })));
});
const gitCredentialMatchStatus = computed(() => gitCredentialMatch.value?.status || "none");
const gitCredentialMatchText = computed(() => {
  const match = gitCredentialMatch.value;
  if (!match) return "";
  if (match.status === "unique") return t("instances.settings.gitCredentialMatchUnique", { name: gitCredentialName(match.credential.id) });
  if (match.status === "ambiguous") return t("instances.settings.gitCredentialMatchAmbiguous", { count: match.credentialIds.length });
  if (match.status === "missing-host-key") return t("instances.settings.gitCredentialMatchHostKey");
  if (match.status === "unsupported") return t("instances.settings.gitCredentialMatchUnsupported");
  return t("instances.settings.gitCredentialMatchNone");
});

function gitCredential(credentialId: string): GitCredentialPublic | undefined { return gitCredentials.data.value?.find((item) => item.id === credentialId); }
function gitCredentialName(credentialId: string) { return gitCredential(credentialId)?.name || credentialId; }
function gitCredentialScope(credentialId: string) {
  const credential = gitCredential(credentialId);
  return credential ? `${credential.scope.scheme}://${credential.scope.host}${credential.scope.port ? `:${credential.scope.port}` : ""}${credential.scope.pathPrefix}` : credentialId;
}
async function refreshGitCredentials() { await Promise.all([gitCredentials.refetch(), gitAssignments.refetch()]); }
async function authorizeGitCredential() {
  const instance = props.instance;
  if (!instance || selectedGitCredentialId.value === noGitCredentialValue) return;
  gitCredentialBusy.value = true;
  try {
    await authorizeInstanceGitCredential(instance.id, selectedGitCredentialId.value);
    selectedGitCredentialId.value = noGitCredentialValue;
    await refreshGitCredentials();
  } catch (cause) { error.value = translateApiError(cause, t, t("instances.settings.gitCredentialAuthorizeFailed")); }
  finally { gitCredentialBusy.value = false; }
}
async function revokeGitCredential(credentialId: string) {
  const instance = props.instance;
  if (!instance) return;
  gitCredentialBusy.value = true;
  try { await revokeInstanceGitCredential(instance.id, credentialId); await refreshGitCredentials(); }
  catch (cause) { error.value = translateApiError(cause, t, t("instances.settings.gitCredentialRevokeFailed")); }
  finally { gitCredentialBusy.value = false; }
}

const generalChanged = computed(() => Boolean(props.instance && (
  instanceName.value.trim() !== props.instance.name
  || autoImportAgentConfigs.value !== props.instance.config.autoImportAgentConfigs
  || defaultCodexPermissionMode.value !== props.instance.config.defaultCodexPermissionMode
  || (historyLimitSupported.value && Number(aiSessionHistoryLimit.value) !== props.instance.config.aiSessionHistoryLimit)
  || (attachmentRetentionSupported.value && Number(aiSessionAttachmentRetentionDays.value) !== props.instance.config.aiSessionAttachmentRetentionDays)
  || (fileAttachmentLimitSupported.value && Number(aiSessionMaxFileAttachmentKiB.value) * 1024 !== props.instance.config.aiSessionMaxFileAttachmentBytes)
)));
const validInstanceName = computed(() => instanceName.value.trim().length > 0);
const validHistoryLimit = computed(() => {
  const value = Number(aiSessionHistoryLimit.value);
  return !historyLimitSupported.value || (Number.isInteger(value) && value >= 1 && value <= AI_SESSION_HISTORY_MAX_LIMIT);
});
const historyLimitSupported = computed(() => {
  const instance = props.instance;
  if (!instance) return false;
  const nodeAgent = instance.node?.capabilities?.agent;
  const nodeCapabilities = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? (nodeAgent as Record<string, unknown>).capabilities
    : undefined;
  const nodeSupported = Boolean(nodeCapabilities && typeof nodeCapabilities === "object" && !Array.isArray(nodeCapabilities)
    && (nodeCapabilities as Record<string, unknown>).aiSessionHistoryLimit === true);
  const features = instance.capabilities?.features;
  const instanceSupported = Boolean(features && typeof features === "object" && !Array.isArray(features)
    && (features as Record<string, unknown>).aiSessionPersistenceSettings === true);
  return nodeSupported && instanceSupported;
});
const validAttachmentRetention = computed(() => {
  const value = Number(aiSessionAttachmentRetentionDays.value);
  return !attachmentRetentionSupported.value || (Number.isInteger(value) && value >= 0 && value <= AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS);
});
const attachmentRetentionSupported = computed(() => {
  const instance = props.instance;
  if (!instance) return false;
  const nodeAgent = instance.node?.capabilities?.agent;
  const nodeCapabilities = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? (nodeAgent as Record<string, unknown>).capabilities
    : undefined;
  const nodeSupported = Boolean(nodeCapabilities && typeof nodeCapabilities === "object" && !Array.isArray(nodeCapabilities)
    && (nodeCapabilities as Record<string, unknown>).aiSessionAttachmentRetention === true);
  const features = instance.capabilities?.features;
  const feature = features && typeof features === "object" && !Array.isArray(features)
    ? (features as Record<string, unknown>).aiSessionConversationAttachments
    : undefined;
  return nodeSupported && Boolean(feature && typeof feature === "object" && !Array.isArray(feature) && (feature as Record<string, unknown>).retentionSettings === true);
});
const validFileAttachmentLimit = computed(() => {
  const value = Number(aiSessionMaxFileAttachmentKiB.value);
  return !fileAttachmentLimitSupported.value || (Number.isInteger(value) && value >= 1 && value <= AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES / 1024);
});
const fileAttachmentLimitSupported = computed(() => {
  const nodeAgent = props.instance?.node?.capabilities?.agent;
  const nodeCapabilities = nodeAgent && typeof nodeAgent === "object" && !Array.isArray(nodeAgent)
    ? (nodeAgent as Record<string, unknown>).capabilities
    : undefined;
  return supportsNodeAiSessionFileAttachmentLimit(nodeCapabilities)
    && supportsAiSessionFileSizeLimitSettings(props.instance?.capabilities);
});
const attachmentRetentionWillShorten = computed(() => Boolean(
  props.instance
  && attachmentRetentionSupported.value
  && Number(aiSessionAttachmentRetentionDays.value) < props.instance.config.aiSessionAttachmentRetentionDays,
));
const legacyModelSelectionNeedsUpgrade = computed(() => {
  const selection = props.instance?.modelSelection;
  return Boolean(selection && !selection.modelEntityIds?.length && legacyModelEntityIds(selection).length);
});
const modelsChanged = computed(() => legacyModelSelectionNeedsUpgrade.value
  || JSON.stringify(normalizedSelection(modelSelection.value)) !== JSON.stringify(normalizedSelection(props.instance?.modelSelection || {})));
const inventoryState = computed<"current" | "stale" | "not-reported" | "empty" | "degraded">(() => {
  const inventory = props.instance?.appInventory;
  if (!inventory) return "not-reported";
  if (inventory.issues.length) return "degraded";
  if (props.instance?.connectionStatus !== "online") return "stale";
  return inventory.items.length ? "current" : "empty";
});
const inventoryStateLabel = computed(() => ({
  current: t("instances.settings.inventoryCurrent"),
  stale: t("instances.settings.inventoryStale"),
  "not-reported": t("instances.settings.notReported"),
  empty: t("instances.settings.inventoryEmpty"),
  degraded: t("instances.settings.inventoryDegraded"),
})[inventoryState.value]);
const inventoryBadgeVariant = computed<"default" | "secondary" | "destructive">(() => inventoryState.value === "current" ? "default" : inventoryState.value === "degraded" ? "destructive" : "secondary");
const customInventoryApps = computed(() => props.instance?.appInventory?.items.filter((app) => app.source === "custom") || []);
const installableAppCount = computed(() => props.appManagement?.apps.filter((app) => app.canInstall).length || 0);
const installedAppCount = computed(() => props.appManagement?.apps.filter((app) => app.state === "installed").length || 0);
const appFilters = computed(() => [
  { value: "all" as const, label: t("instances.settings.filterAll"), count: props.appManagement?.apps.length || 0 },
  { value: "available" as const, label: t("instances.settings.filterAvailable"), count: installableAppCount.value },
  { value: "installed" as const, label: t("instances.settings.filterInstalled"), count: installedAppCount.value },
]);
const filteredManagedApps = computed(() => {
  const apps = props.appManagement?.apps || [];
  if (appFilter.value === "available") return apps.filter((app) => app.canInstall);
  if (appFilter.value === "installed") return apps.filter((app) => app.state === "installed");
  return apps;
});

watch(
  [() => props.open, () => props.instance?.id, () => props.initialSection],
  ([open]) => {
    if (!open || !props.instance) return;
    section.value = props.initialSection || "general";
    instanceName.value = props.instance.name;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    defaultCodexPermissionMode.value = props.instance.config.defaultCodexPermissionMode;
    aiSessionHistoryLimit.value = String(props.instance.config.aiSessionHistoryLimit);
    aiSessionAttachmentRetentionDays.value = String(props.instance.config.aiSessionAttachmentRetentionDays);
    aiSessionMaxFileAttachmentKiB.value = String(props.instance.config.aiSessionMaxFileAttachmentBytes / 1024);
    modelSelection.value = normalizedSelection(props.instance.modelSelection);
    error.value = "";
    success.value = "";
    appFilter.value = "all";
  },
  { immediate: true },
);

watch(() => props.instance, (instance) => {
  if (props.open && !instance) handleOpenChange(false);
});

watch(
  [() => props.open, () => props.instance?.id, () => section.value],
  ([open, instanceId, activeSection]) => {
    if (open && instanceId && activeSection === "apps") void props.refreshAppManagement(instanceId);
  },
  { immediate: true },
);

function handleOpenChange(open: boolean) {
  if (!open) {
    section.value = "general";
    error.value = "";
    success.value = "";
  }
  emit("update:open", open);
}

const modelEntityIds = computed<string[]>({
  get: () => modelSelection.value.modelEntityIds || [],
  set: (value) => {
    modelSelection.value = { modelEntityIds: [...new Set(value)] };
    error.value = "";
    success.value = "";
  },
});

function legacyModelEntityIds(value: ModelSelection) {
  return [...new Set([value.codexModelHash, value.claudeModelHash, value.opencodeModelHash]
    .filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function normalizedSelection(value: ModelSelection): ModelSelection {
  const ids = [...new Set(value.modelEntityIds?.length ? value.modelEntityIds : legacyModelEntityIds(value))];
  return ids.length ? { modelEntityIds: ids } : {};
}

async function saveGeneral() {
  if (!props.instance || savingGeneral.value || !validInstanceName.value || !validHistoryLimit.value || !validAttachmentRetention.value || !validFileAttachmentLimit.value) return;
  savingGeneral.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.updateInstance(props.instance, {
      name: instanceName.value.trim(),
      config: {
        autoImportAgentConfigs: autoImportAgentConfigs.value,
        defaultCodexPermissionMode: defaultCodexPermissionMode.value,
        ...(historyLimitSupported.value ? { aiSessionHistoryLimit: Number(aiSessionHistoryLimit.value) } : {}),
        ...(attachmentRetentionSupported.value ? { aiSessionAttachmentRetentionDays: Number(aiSessionAttachmentRetentionDays.value) } : {}),
        ...(fileAttachmentLimitSupported.value ? { aiSessionMaxFileAttachmentBytes: Number(aiSessionMaxFileAttachmentKiB.value) * 1024 } : {}),
      },
    });
    instanceName.value = instanceName.value.trim();
    success.value = t("instances.settings.generalSaved");
  } catch (cause) {
    instanceName.value = props.instance.name;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    defaultCodexPermissionMode.value = props.instance.config.defaultCodexPermissionMode;
    aiSessionHistoryLimit.value = String(props.instance.config.aiSessionHistoryLimit);
    aiSessionAttachmentRetentionDays.value = String(props.instance.config.aiSessionAttachmentRetentionDays);
    aiSessionMaxFileAttachmentKiB.value = String(props.instance.config.aiSessionMaxFileAttachmentBytes / 1024);
    error.value = translateApiError(cause, t);
  } finally {
    savingGeneral.value = false;
  }
}

async function saveModels() {
  if (!props.instance || savingModels.value) return;
  savingModels.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.updateInstance(props.instance, { modelSelection: normalizedSelection(modelSelection.value) });
    success.value = t("instances.settings.modelsSaved");
  } catch (cause) {
    modelSelection.value = normalizedSelection(props.instance.modelSelection);
    error.value = translateApiError(cause, t);
  } finally {
    savingModels.value = false;
  }
}

function formatObservedAt(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDateTime(parsed, locale.value);
}

function refreshApps() {
  if (props.instance) void props.refreshAppManagement(props.instance.id);
}

function activeJob(app: ManagedAppProjection) {
  return props.appManagement?.activeJobs.find((job) => job.id === app.activeJobId || job.appId === app.id);
}

function terminalJob(app: ManagedAppProjection) {
  return props.appManagement?.recentJobs.find((job) => job.appId === app.id);
}

function executionJob(app: ManagedAppProjection) {
  return activeJob(app) || terminalJob(app);
}

function executionOutput(job: AppManagementJob) {
  if (job.logTail) return job.logTail;
  if (!job.command) return t("instances.settings.waitingInstaller");
  return `$ ${[job.command.executable, ...job.command.args].map(commandArgument).join(" ")}\n`;
}

function commandArgument(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function progressPercent(job?: AppManagementJob) {
  if (!job?.progress?.total || job.progress.current === undefined) return undefined;
  return Math.max(0, Math.min(100, (job.progress.current / job.progress.total) * 100));
}

function jobLabel(job: AppManagementJob) {
  const operation = job.operation === "install" ? t("instances.settings.installing") : t("instances.settings.uninstalling");
  return `${job.state === "queued" ? t("instances.settings.queued") : operation}${job.phase ? ` · ${humanizeJobPhase(job.phase)}` : ""}`;
}

function humanizeJobPhase(phase: string) {
  return phase.replace(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}

function terminalJobLabel(job: AppManagementJob) {
  const operation = job.operation === "install" ? t("instances.settings.installation") : t("instances.settings.uninstallation");
  if (job.state === "succeeded") return t("instances.settings.succeeded", { operation });
  if (job.state === "cancelled") return t("instances.settings.cancelled", { operation });
  if (job.state === "interrupted") return t("instances.settings.interrupted", { operation });
  return t("instances.settings.failed", { operation });
}

function managedAppBadgeVariant(state: ManagedAppProjection["state"]): "default" | "secondary" | "destructive" {
  return state === "installed" ? "default" : state === "broken" ? "destructive" : "secondary";
}

function managedAppStateLabel(state: ManagedAppProjection["state"]) {
  return ({
    installed: t("instances.settings.stateInstalled"),
    "not-installed": t("instances.settings.stateNotInstalled"),
    broken: t("instances.settings.stateBroken"),
    unsupported: t("instances.settings.stateUnsupported"),
  })[state];
}

function managedAppIcon(app: ManagedAppProjection) {
  if (app.kind === "gui") return app.id === "chromium" ? Globe2 : Monitor;
  if (app.kind === "web") return Globe2;
  return TerminalSquare;
}

function appActionHint(app: ManagedAppProjection) {
  if (activeJob(app) || app.canInstall || app.canUninstall) return "";
  const reason = app.state === "installed" ? app.uninstallReason : app.installReason;
  if (reason?.code === "BUNDLED" && app.state === "not-installed") return t("instances.settings.bundledUnavailable");
  return reason?.message || t("instances.settings.noAction");
}

function openAppConfirmation(app: ManagedAppProjection, operation: AppManagementOperation) {
  appConfirmation.value = { app, operation };
  error.value = "";
  success.value = "";
}

async function confirmAppOperation() {
  if (!props.instance || !appConfirmation.value || operationSubmitting.value) return;
  const { app, operation } = appConfirmation.value;
  operationSubmitting.value = app.id;
  error.value = "";
  success.value = "";
  try {
    await props.manageApp(props.instance.id, app.id, operation);
    success.value = t("instances.settings.operationQueued", {
      operation: operation === "install" ? t("instances.settings.installation") : t("instances.settings.uninstallation"),
      name: app.name,
    });
    appConfirmation.value = undefined;
  } catch (cause) {
    error.value = translateApiError(cause, t);
  } finally {
    operationSubmitting.value = "";
  }
}
</script>

<style scoped>
:global(.instance-settings-dialog[role="dialog"]) {
  width: min(920px, calc(100vw - 36px));
  max-width: 920px;
  height: 680px;
  max-height: calc(100vh - 36px);
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 14px;
}

.instance-settings-header {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
}

.instance-settings-heading {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-settings-heading > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.instance-settings-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.instance-settings-title-row :deep(h2) {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-settings-heading :deep(p) {
  color: var(--text-muted);
  font-size: 12px;
}

.instance-settings-close {
  display: grid;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: var(--surface-hover);
  color: var(--text-muted);
  cursor: pointer;
}

.instance-settings-close:hover,
.instance-settings-close:focus-visible {
  background: var(--surface-active);
  color: var(--text-strong);
  outline: none;
}

.instance-settings-tabs {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
}

.instance-settings-tabs-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  width: 100%;
  height: auto;
  min-height: 36px;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 2px;
}

.instance-settings-tabs-list :deep(button) {
  height: 30px;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
  padding: 0 8px;
}

.instance-settings-tabs-list :deep(.truncate) {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.instance-settings-tabs-list :deep(.truncate svg) {
  flex: 0 0 auto;
}

.instance-settings-tabs-list :deep(button:not([data-state="active"]):hover) {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.instance-settings-tabs-list :deep(button[data-state="active"]) {
  background: var(--surface-active);
  color: var(--text-strong);
  box-shadow: none;
}

.instance-settings-scroll {
  height: 100%;
  min-height: 0;
}

.instance-settings-section {
  display: grid;
  gap: 18px;
  margin: 0;
  padding: 2px 10px 18px 2px;
}

.instance-settings-section[hidden] {
  display: none;
}

.instance-settings-card {
  display: grid;
  gap: 12px;
}

.instance-settings-card h3,
.instance-app-heading h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}

.instance-settings-section-heading {
  display: grid;
  gap: 2px;
  padding: 0 2px;
}

.instance-settings-section-heading p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.instance-settings-group {
  gap: 7px;
}

.instance-settings-surface {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-raised);
}

.instance-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  margin: 0;
}

.instance-settings-grid div {
  display: grid;
  min-width: 0;
  gap: 4px;
  padding: 12px 16px;
}

.instance-settings-grid div:nth-child(even) {
  border-left: 1px solid var(--line);
}

.instance-settings-grid div:nth-child(n + 3) {
  border-top: 1px solid var(--line);
}

.instance-settings-grid dt {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
}

.instance-settings-grid dd {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
  line-height: 1.5;
}

.instance-settings-grid code {
  color: inherit;
  font-size: 11px;
}

.instance-settings-control-surface {
  display: grid;
}

.instance-settings-general-controls {
  display: grid;
  gap: 0;
}

.instance-settings-general-controls > label {
  padding: 14px 16px;
}

.instance-settings-general-controls > label + label,
.instance-settings-general-controls > .instance-settings-row-note + label,
.instance-settings-general-controls > label + .instance-settings-row-note {
  border-top: 1px solid var(--line);
}

.instance-settings-general-actions {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--line);
  padding: 10px 16px;
}

.instance-settings-row-note {
  background: var(--surface-inset);
  padding: 8px 16px;
}

.instance-settings-checkbox {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.instance-settings-checkbox span,
.instance-settings-name-control > span,
.instance-settings-select-control > span {
  display: grid;
  gap: 5px;
}

.instance-settings-checkbox small,
.instance-settings-name-control small,
.instance-settings-select-control small,
.instance-model-grid small,
.instance-app-row small,
.instance-settings-help,
.instance-settings-observed {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.instance-settings-checkbox strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-settings-name-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 16px;
}

.instance-settings-name-control strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-settings-select-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 16px;
}

.instance-settings-select-control strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-model-surface {
  display: grid;
}


.instance-app-heading,
.instance-app-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.instance-app-heading-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.instance-app-heading-actions :deep(button) {
  width: 28px;
  height: 28px;
}

.instance-app-heading > .instance-settings-section-heading {
  min-width: 0;
}

.instance-app-toolbar {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--line);
  padding: 6px 10px;
}

.instance-app-toolbar > small {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.instance-app-filters {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
}

.instance-app-filters :deep(button) {
  height: 27px;
  gap: 6px;
  padding-inline: 9px;
}

.instance-app-filters :deep(button span) {
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.instance-app-list {
  display: grid;
  gap: 8px;
}

.instance-directory-list {
  gap: 0;
}

.instance-directory-list .instance-app-row {
  min-height: 68px;
  padding: 10px 12px;
}

.instance-directory-list .instance-app-row + .instance-app-row {
  border-top: 1px solid var(--line);
}

.instance-app-row > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-managed-app-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
  justify-content: normal;
  background: transparent;
}

.instance-app-copy {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 3px;
}

.instance-app-copy > strong {
  color: var(--text-strong);
  font-size: 13px;
}

.instance-app-main,
.instance-app-identity {
  display: flex !important;
  min-width: 0;
  align-items: flex-start;
}

.instance-app-main {
  justify-content: space-between;
  gap: 16px;
}

.instance-app-identity {
  flex: 1 1 auto;
  gap: 10px;
}

.instance-app-icon {
  display: grid;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--brand-accent-muted);
}

.instance-app-controls {
  display: flex !important;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px !important;
}

.instance-app-action-reason {
  color: var(--text-muted);
}

.instance-app-activity {
  display: grid !important;
  gap: 5px !important;
  border-top: 1px solid var(--line);
  margin-top: 10px;
  padding-top: 9px;
}

.instance-app-job-line {
  color: var(--brand-accent-muted) !important;
  font-weight: 700;
}

.instance-app-progress {
  width: min(300px, 100%);
  margin-top: 3px;
}

.instance-app-terminal {
  width: 100%;
  margin-top: 5px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #071014;
}

.instance-app-confirmation-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 10px;
}

.instance-app-confirmation-summary span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-app-confirmation-summary small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.instance-app-confirmation-summary strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-app-terminal summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  padding: 7px 9px;
  user-select: none;
}

.instance-app-terminal pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  border-top: 1px solid var(--line);
  color: #d7e3e7;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  padding: 9px;
  white-space: pre-wrap;
  word-break: break-word;
}

.instance-app-row code,
.instance-app-issues code {
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-size: 11px;
}

.instance-app-issues {
  border-top: 1px solid var(--line);
  background: var(--surface-inset);
  padding: 10px 12px;
  color: var(--text);
  font-size: 12px;
}

.instance-app-issues p {
  margin: 5px 0 0;
}

.instance-settings-error {
  margin: 0;
  color: var(--status-danger);
  font-size: 12px;
}

.instance-settings-success {
  margin: 0;
  color: var(--status-success);
  font-size: 12px;
}

.instance-settings-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 18px 0;
}

.instance-settings-state {
  display: flex;
  min-height: 112px;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 12px;
  padding: 18px;
  text-align: center;
}

.instance-settings-state-error {
  color: var(--status-danger);
}

.instance-settings-empty-state {
  display: grid;
  gap: 7px;
  justify-items: center;
}

.instance-app-directory,
.instance-git-directory {
  display: grid;
}

.instance-git-assignment-create {
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(0, 1fr) auto;
  border-bottom: 1px solid var(--line);
  padding: 10px 12px;
}

.instance-git-match-preview {
  align-items: center;
  background: var(--surface-inset);
  border-bottom: 1px solid var(--line);
  color: var(--text-muted);
  display: grid;
  font-size: 12px;
  gap: 8px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  padding: 10px 12px;
}

.instance-git-match-preview[data-status="unique"] {
  color: var(--text);
}

.instance-git-assignment-row > div:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.instance-git-assignment-row {
  align-items: center;
}

.instance-directory-identity {
  display: flex !important;
  min-width: 0;
  align-items: flex-start;
  gap: 10px !important;
}

.instance-directory-identity > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-directory-identity strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.instance-custom-app-row {
  align-items: center;
}

.instance-git-assignment-row small {
  color: var(--text-muted);
  font-size: 12px;
}

.instance-git-assignment-actions {
  align-items: center;
  display: flex;
  gap: 8px;
}

@media (max-width: 680px) {
  .instance-settings-grid {
    grid-template-columns: 1fr;
  }

  .instance-settings-tabs-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .instance-settings-name-control,
  .instance-settings-select-control {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .instance-settings-grid div:nth-child(even) {
    border-left: 0;
  }

  .instance-settings-grid div:nth-child(n + 2) {
    border-top: 1px solid var(--line);
  }

  .instance-managed-app-row {
    padding: 10px;
  }

  .instance-app-toolbar,
  .instance-app-main {
    align-items: stretch;
    flex-direction: column;
  }

  .instance-app-controls {
    width: 100%;
    max-width: none;
    align-items: flex-start;
    justify-items: start;
  }

  .instance-app-confirmation-summary {
    grid-template-columns: 1fr;
  }

  .instance-git-assignment-create {
    align-items: stretch;
    grid-template-columns: 1fr;
  }
}
</style>
