<template>
  <ScrollArea class="cloud-connectivity-scroll settings-page-scroll" :horizontal="false">
    <div class="cloud-connectivity-page settings-content-page">
      <header class="cloud-page-head">
        <p>{{ t("settings.cloud.description") }}</p>
      </header>
      <Tabs v-model="tab" class="cloud-tabs">
        <TabsList class="cloud-tabs-list">
          <TabsTrigger value="connection">{{ t("settings.cloud.tabs.connection") }}</TabsTrigger>
          <TabsTrigger value="node-management">{{ t("settings.cloud.tabs.nodeManagement") }}</TabsTrigger>
          <TabsTrigger value="roles">{{ t("settings.cloud.tabs.roles") }}</TabsTrigger>
          <TabsTrigger value="trusted-devices">{{ t("settings.cloud.tabs.trustedDevices") }}</TabsTrigger>
        </TabsList>
      </Tabs>

      <template v-if="tab === 'connection'">
        <section class="cloud-directory">
          <header class="cloud-directory-head"><strong>{{ t("settings.cloud.relayTitle") }}</strong></header>
          <div v-if="query.isLoading.value || account.isLoading.value" class="cloud-state" role="status">{{ t("settings.cloud.loading") }}</div>
          <div v-else-if="query.error.value" class="cloud-error" role="alert">
            <span>{{ errorText(query.error.value) }}</span>
            <Button variant="outline" size="sm" @click="query.refetch()">{{ t("common.actions.retry") }}</Button>
          </div>
          <div v-else-if="account.error.value" class="cloud-error" role="alert">
            <span>{{ errorText(account.error.value) }}</span>
            <Button variant="outline" size="sm" @click="account.refetch()">{{ t("common.actions.retry") }}</Button>
          </div>
          <div v-else-if="state" class="cloud-content">
            <div class="cloud-connection-overview">
              <div class="cloud-summary" role="status">
                <strong>{{ stageTitle }}</strong>
                <span>{{ stageDetail }}</span>
                <p v-if="connectionStage === 'active'" class="cloud-hint">{{ t("settings.cloud.backgroundNote") }}</p>
              </div>
              <div v-if="showConnectionActions" class="cloud-connection-actions">
                <template v-if="connectionStage === 'signed-out'">
                  <Button size="sm" :disabled="busy" @click="signIn('bind')">{{ pendingAction === 'sign-in' && loginIntent === 'bind' ? t("settings.cloud.opening") : t("settings.cloud.loginAndBind") }}</Button>
                  <Button variant="outline" size="sm" :disabled="busy" @click="signIn('sign-in')">{{ pendingAction === 'sign-in' && loginIntent === 'sign-in' ? t("settings.cloud.opening") : t("settings.cloud.signInOnly") }}</Button>
                </template>
                <Button v-else-if="connectionStage === 'signed-in-unbound'" size="sm" :disabled="busy" @click="beginBinding">{{ pendingAction === 'bind' ? t("settings.cloud.opening") : t("settings.cloud.bindToAccount") }}</Button>
                <Button v-else-if="connectionStage === 'revoking'" variant="outline" size="sm" :disabled="busy" @click="retryRevocation">{{ pendingAction === 'disconnect' ? t("settings.cloud.loading") : t("settings.cloud.retryRevocation") }}</Button>
              </div>
            </div>
            <div v-if="originConflict" class="cloud-warning cloud-origin-conflict" role="alert">
              <p>{{ t("settings.cloud.bindingOrigin") }}: <code>{{ state.serviceOrigin }}</code></p>
              <p>{{ t("settings.cloud.configuredOrigin") }}: <code>{{ originConflict.configuredServiceOrigin }}</code></p>
            </div>
            <p v-if="requestFailure" class="cloud-warning" role="alert">
              {{ requestFailureMessage }}
              <code>{{ requestFailure.code }}</code>
            </p>
            <p v-if="reauthRequired && !waitingForSignIn" class="cloud-warning" role="alert">
              {{ t("settings.cloud.sessionExpired") }}
              <button v-if="connectionStage !== 'active'" type="button" class="cloud-link" :disabled="busy" @click="signIn('sign-in')">{{ t("settings.cloud.signIn") }}</button>
            </p>
            <p v-if="waitingForSignIn || waitingForBinding" class="cloud-pending" role="status">
              {{ pendingMessage }}
              <button type="button" class="cloud-link" @click="reopen(pendingUrl)">{{ t("settings.cloud.reopen") }}</button>
            </p>
            <p v-if="state.remoteResult === 'unknown' || state.status === 'pending-revocation'" class="cloud-warning" role="status">{{ t("settings.cloud.resultUnknown") }}</p>

            <section v-if="signedIn || connectionStage === 'active'" class="cloud-account-row">
              <div class="cloud-setting-copy">
                <strong>{{ t("settings.cloud.accountTitle") }}</strong>
                <span v-if="signedIn" class="cloud-account-email">{{ session?.email || session?.accountId }}</span>
                <p class="cloud-hint">{{ t(signedIn ? "settings.cloud.accountSessionNote" : "settings.cloud.accountSignedOutNote") }}</p>
              </div>
              <Button v-if="signedIn" variant="outline" size="sm" :disabled="busy || waitingForBinding" @click="signOutOpen = true">{{ t("settings.cloud.signOut") }}</Button>
              <Button v-else variant="outline" size="sm" :disabled="busy || waitingForSignIn || Boolean(originConflict)" @click="signIn('sign-in')">{{ pendingAction === 'sign-in' ? t("settings.cloud.opening") : t("settings.cloud.signIn") }}</Button>
            </section>

            <section v-if="connectionStage === 'active'" class="cloud-subsection" :aria-busy="savingDeviceAccess">
              <header class="cloud-subsection-head"><strong>{{ t("settings.cloud.scopesTitle") }}</strong></header>
              <label class="cloud-scope">
                <span><strong>{{ t("settings.cloud.deviceAccess") }}</strong><small>{{ t("settings.cloud.deviceAccessHint") }}</small></span>
                <Checkbox :model-value="state.scopes.deviceAccess" :disabled="busy" :aria-label="t('settings.cloud.deviceAccess')" @update:model-value="(value) => setDeviceAccess(value === true)" />
              </label>
              <p v-if="savingDeviceAccess" class="cloud-hint" role="status">{{ t("settings.cloud.savingDeviceAccess") }}</p>
              <p v-if="!state.scopes.deviceAccess" class="cloud-hint" role="status">{{ t("settings.cloud.deviceAccessOffNote") }}</p>
            </section>

            <details class="cloud-advanced">
              <summary>{{ t("settings.cloud.advanced") }}</summary>
              <dl class="cloud-identity">
                <div><dt>{{ t("settings.cloud.controlPlaneId") }}</dt><dd>{{ state.identity.controlPlaneId }}</dd></div>
                <div v-if="state.cloudControlPlaneId"><dt>{{ t("settings.cloud.cloudControlPlaneId") }}</dt><dd>{{ state.cloudControlPlaneId }}</dd></div>
                <div><dt>{{ t("settings.cloud.fingerprint") }}</dt><dd><code>{{ state.identity.fingerprint }}</code></dd></div>
                <div v-if="state.bindingRevision"><dt>{{ t("settings.cloud.revision") }}</dt><dd>{{ state.bindingRevision }}</dd></div>
                <div v-if="state.accountId"><dt>{{ t("settings.cloud.boundAccount") }}</dt><dd>{{ boundAccountLabel }}</dd></div>
                <div v-if="session?.sessionExpiresAt"><dt>{{ t("settings.cloud.accountExpires") }}</dt><dd>{{ formatDate(session.sessionExpiresAt) }}</dd></div>
                <div><dt>{{ t("settings.cloud.background") }}</dt><dd>{{ state.hasBackgroundCredential ? t("settings.cloud.running") : t("settings.cloud.notConnected") }}</dd></div>
              </dl>
            </details>
          </div>
        </section>
        <section v-if="canDisconnect && !query.error.value && !account.error.value" class="cloud-directory cloud-danger">
          <div class="cloud-setting-copy">
            <strong>{{ disconnectLabel }}</strong>
            <p class="cloud-hint">{{ t(originConflict ? "settings.cloud.resetBindingNote" : "settings.cloud.disconnectNote") }}</p>
          </div>
          <Button variant="destructive" size="sm" :disabled="busy" @click="disconnectOpen = true">{{ disconnectLabel }}</Button>
        </section>
      </template>

      <template v-if="tab === 'node-management' && state?.status === 'active' && !originConflict">
        <p class="cloud-hint">{{ t("settings.cloud.nodeManagementNote") }}</p>
        <section class="cloud-directory cloud-node-picker" :aria-label="t('settings.cloud.nodeListTitle')">
          <header class="cloud-directory-head cloud-node-picker-head">
            <span>
              <strong>{{ t("settings.cloud.nodeListTitle") }}</strong>
              <small>{{ t("settings.cloud.nodeListHint") }}</small>
            </span>
            <small>{{ t("settings.cloud.nodeListCount", { count: cloudNodes.length }) }}</small>
          </header>
          <p v-if="!signedIn" class="cloud-node-picker-warning" role="status">
            <span>{{ t("settings.cloud.nodeAddRequiresSignIn") }}</span>
            <button type="button" class="cloud-link" :disabled="busy || waitingForSignIn || Boolean(originConflict)" @click="signIn('sign-in')">{{ t("settings.cloud.signIn") }}</button>
          </p>
          <p v-else-if="!canAddCloudNodes" class="cloud-node-picker-warning" role="status">
            {{ t("settings.cloud.nodeAddRequiresBinding") }}
          </p>
          <p v-if="nodes.isLoading.value" class="cloud-node-picker-state" role="status">{{ t("settings.cloud.nodeListLoading") }}</p>
          <div v-else-if="nodes.error.value" class="cloud-node-picker-error" role="alert">
            <span>{{ t("settings.cloud.nodeListFailed") }} {{ errorText(nodes.error.value) }}</span>
            <Button variant="outline" size="sm" @click="nodes.refetch()">{{ t("common.actions.retry") }}</Button>
          </div>
          <p v-else-if="!cloudNodes.length" class="cloud-node-picker-state">{{ t("settings.cloud.nodeListEmpty") }}</p>
          <div v-else class="cloud-node-picker-list">
            <button
              v-for="node in cloudNodes"
              :key="node.id"
              type="button"
              class="cloud-node-row"
              :disabled="Boolean(nodeCloudHandle(node)) || Boolean(addingNodeId) || busy || !canAddCloudNodes"
              @click="addNode(node)"
            >
              <span class="cloud-node-identity">
                <strong>{{ node.name }}</strong>
                <small>{{ nodeMeta(node) }}</small>
              </span>
              <span class="cloud-node-action">
                <Badge v-if="nodeCloudHandle(node)" variant="secondary">{{ t("settings.cloud.nodeAdded") }}</Badge>
                <template v-else>
                  <span>{{ nodeActionLabel(node) }}</span>
                  <Cloud :size="14" aria-hidden="true" />
                </template>
              </span>
            </button>
          </div>
        </section>
        <p class="cloud-hint">{{ t("settings.cloud.nodeManagementUnbindNote") }}</p>
      </template>
      <p v-else-if="tab === 'node-management' && query.isLoading.value" class="cloud-state" role="status">{{ t("settings.cloud.loading") }}</p>
      <p v-else-if="tab === 'node-management'" class="cloud-state">{{ t("settings.cloud.nodeManagementRequiresConnection") }}</p>

      <template v-if="tab === 'roles' && state?.status === 'active' && !originConflict">
        <p class="cloud-hint">{{ t("settings.cloud.rolesNote") }}</p>
        <section class="cloud-directory" :aria-label="t('settings.cloud.rolesTitle')">
          <header class="cloud-directory-head">
            <strong>{{ t("settings.cloud.rolesTitle") }}</strong>
            <span v-if="accessSettings.data.value" class="cloud-revision">{{ t("settings.cloud.rolesSettingsRevision", { revision: accessSettings.data.value.settingsRevision }) }}</span>
          </header>
          <div v-if="accessSettings.isLoading.value" class="cloud-state" role="status">{{ t("settings.cloud.loading") }}</div>
          <div v-else-if="accessSettings.error.value" class="cloud-error" role="alert">
            <span>{{ errorText(accessSettings.error.value) }}</span>
            <Button variant="outline" size="sm" @click="accessSettings.refetch()">{{ t("common.actions.retry") }}</Button>
          </div>
          <div v-else-if="accessSettings.data.value" class="cloud-role-list">
            <div v-for="role in accessSettings.data.value.roles" :key="role.roleId" class="cloud-role-row" :data-archived="role.status === 'archived'">
              <Checkbox
                :model-value="roleDraft.includes(role.roleId)"
                :disabled="busy || savingRoles || role.roleId === accessSettings.data.value.ownerRoleId || (role.status === 'archived' && !roleDraft.includes(role.roleId))"
                :aria-label="t(roleDraft.includes(role.roleId) ? 'settings.cloud.rolesRemove' : 'settings.cloud.rolesAdd', { name: role.name })"
                @update:model-value="(value) => toggleAvailableRole(role.roleId, value === true)"
              />
              <span class="cloud-role-copy">
                <span class="cloud-role-title">
                  <strong>{{ role.name }}</strong>
                  <Badge v-if="role.system" variant="secondary">{{ t("settings.cloud.rolesBuiltIn") }}</Badge>
                  <Badge v-if="role.status === 'archived'" variant="secondary">{{ t("settings.cloud.rolesArchived") }}</Badge>
                  <Badge v-if="role.roleId === accessSettings.data.value.ownerRoleId" variant="default">{{ t("settings.cloud.rolesOwner") }}</Badge>
                </span>
                <small>{{ role.description || t("settings.cloud.rolesNoDescription") }}</small>
                <code>{{ role.roleId }}</code>
              </span>
              <span class="cloud-role-state">{{ roleDraft.includes(role.roleId) ? t("settings.cloud.rolesAvailable") : t("settings.cloud.rolesUnavailable") }}</span>
            </div>
          </div>
        </section>
        <template v-if="accessSettings.data.value && !accessSettings.isLoading.value && !accessSettings.error.value">
          <div class="cloud-catalog-meta">
            <span>{{ t("settings.cloud.rolesCatalogRevision", { revision: accessSettings.data.value.catalogRevision }) }}</span>
            <span>{{ catalogPublicationLabel }}</span>
            <span v-if="state.catalogPublication?.errorCode" class="cloud-role-publication-error"><code>{{ state.catalogPublication.errorCode }}</code></span>
          </div>
          <p v-if="archivedDraftRoles.length" class="cloud-warning" role="status">
            {{ t("settings.cloud.rolesArchivedSelected", { roles: archivedDraftRoles.map((role) => role.name).join(", ") }) }}
          </p>
          <div class="cloud-role-actions">
            <span class="cloud-role-dirty">{{ rolesDirty ? t("settings.cloud.rolesUnsaved") : t("settings.cloud.rolesSaved") }}</span>
            <Button v-if="rolesDirty" variant="outline" size="sm" :disabled="savingRoles" @click="resetRoleDraft">{{ t("settings.cloud.rolesReset") }}</Button>
            <Button size="sm" :disabled="!canSaveRoles" @click="saveAvailableRoles">{{ savingRoles ? t("settings.cloud.rolesSaving") : t("settings.cloud.rolesSave") }}</Button>
          </div>
          <div v-if="roleUpdateError" class="cloud-role-error" role="alert">
            <strong>{{ roleUpdateError.message }}</strong>
            <ul v-if="roleUpdateError.details.length"><li v-for="detail in roleUpdateError.details" :key="detail">{{ detail }}</li></ul>
            <code>{{ roleUpdateError.code }}</code>
          </div>
        </template>
      </template>

      <p v-if="tab === 'roles' && (state?.status !== 'active' || originConflict)" class="cloud-state">{{ t(originConflict ? "settings.cloud.originConflictNote" : "settings.cloud.rolesRequiresConnection") }}</p>
      <TrustedDevicesSettingsSection v-if="tab === 'trusted-devices'" />
    </div>
  </ScrollArea>

  <Dialog :open="stepUpOpen" @update:open="(open) => { if (!open) cancelStepUp(); }">
    <DialogContent class="cloud-step-up-dialog">
      <form class="cloud-step-up-form" @submit.prevent="confirmStepUp">
        <DialogHeader>
          <DialogTitle>{{ t("settings.cloud.stepUpTitle") }}</DialogTitle>
          <DialogDescription>{{ t("settings.cloud.stepUpDescription") }}</DialogDescription>
        </DialogHeader>
        <label class="cloud-step-up-field">
          <span>{{ t("settings.cloud.stepUpPassword") }}</span>
          <Input v-model="stepUpPassword" type="password" autocomplete="current-password" :disabled="stepUpBusy" />
        </label>
        <p v-if="stepUpError" class="cloud-warning" role="alert">{{ stepUpError }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" :disabled="stepUpBusy" @click="cancelStepUp">{{ t("common.actions.cancel") }}</Button>
          <Button type="submit" size="sm" :disabled="stepUpBusy || !stepUpPassword">{{ stepUpBusy ? t("settings.cloud.stepUpChecking") : t("settings.cloud.stepUpConfirm") }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="signOutOpen" @update:open="(open) => { if (!busy) signOutOpen = open; }">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ t("settings.cloud.signOut") }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t("settings.cloud.signOutConfirm") }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="busy">{{ t("common.actions.cancel") }}</AlertDialogCancel>
        <Button variant="outline" :disabled="busy" @click="signOut">{{ t("settings.cloud.signOut") }}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="disconnectOpen" @update:open="(open) => { if (!busy) disconnectOpen = open; }">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ disconnectLabel }}</AlertDialogTitle>
        <AlertDialogDescription>{{ t(originConflict ? "settings.cloud.resetBindingConfirm" : "settings.cloud.disconnectConfirm") }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="busy">{{ t("common.actions.cancel") }}</AlertDialogCancel>
        <Button variant="destructive" :disabled="busy" @click="disconnect">{{ disconnectLabel }}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud } from "@lucide/vue";
import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL } from "@task-handoff/protocol/control-plane";
import { ApiError } from "../../../api/client";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { bindCloudRelayNode, createCloudBindingRequest, createCloudSignInRequest, disconnectCloudAccount, resetConflictingCloudBinding, signOutCloudAccount, stepUpControlPlaneAuthentication, updateCloudAvailableRoles, updateCloudRemoteAccess, useCloudAccessSettingsQuery, useCloudAccountQuery, useCloudConnectivityQuery, useCloudNodeRelayQuery, useNodesQuery } from "../../../api/queries";
import type { Node } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { nodeConnectionModeKeys, nodeRuntimeStatusKeys, translateStatus } from "../../../i18n/status";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import TrustedDevicesSettingsSection from "./TrustedDevicesSettingsSection.vue";
import { resolveCloudConnectionStage, type CloudConnectionStage, type CloudLoginIntent } from "./cloudConnectionState";

const { locale, t } = useI18n();
type ConnectionStage = CloudConnectionStage;
type LoginIntent = CloudLoginIntent;

const tab = ref<"connection" | "node-management" | "roles" | "trusted-devices">("connection");
const query = useCloudConnectivityQuery();
const account = useCloudAccountQuery();
const nodes = useNodesQuery();
const pendingAction = ref<"sign-in" | "sign-out" | "bind" | "device-access" | "disconnect" | null>(null);
const busy = computed(() => pendingAction.value !== null);
const savingDeviceAccess = computed(() => pendingAction.value === "device-access");
const loginIntent = ref<LoginIntent | null>(null);
const signOutOpen = ref(false);
const disconnectOpen = ref(false);
const addingNodeId = ref("");
const addedCloudNodeHandles = ref<Record<string, string>>({});
const state = computed(() => query.data.value);
const originConflict = computed(() => state.value?.originConflict);
const disconnectLabel = computed(() => t(originConflict.value ? "settings.cloud.resetBinding" : "settings.cloud.disconnect"));
const accessSettings = useCloudAccessSettingsQuery({ enabled: () => state.value?.status === "active" && !originConflict.value });
const session = computed(() => account.data.value);
const signedIn = computed(() => Boolean(session.value?.signedIn));
const reauthRequired = computed(() => Boolean(session.value?.reauthRequired));
const cloudNodes = computed(() => nodes.data.value || []);
const canAddCloudNodes = computed(() => signedIn.value && state.value?.status === "active" && !originConflict.value);
const nodeRelay = useCloudNodeRelayQuery({
  enabled: () => canAddCloudNodes.value,
  refetchIntervalMs: () => addingNodeId.value ? false : 5_000,
});
const pendingScope = computed(() => session.value?.pendingRequest?.scope);
const pendingUrl = computed(() => session.value?.pendingRequest?.authorizationUrl);
const requestFailure = computed(() => session.value?.requestFailure);
const requestFailureMessage = computed(() => requestFailure.value?.scope === "control-plane:bind"
  ? t("settings.cloud.bindingDeliveryFailed")
  : t("settings.cloud.signInDeliveryFailed"));
const waitingForSignIn = computed(() => pendingScope.value === "account:sign-in");
const waitingForBinding = computed(() => pendingScope.value === "control-plane:bind");
const connectionStage = computed<ConnectionStage>(() => resolveCloudConnectionStage({
  status: state.value?.status,
  originConflict: originConflict.value,
  signedIn: signedIn.value,
  pendingScope: pendingScope.value,
}));
const accountLabel = computed(() => session.value?.email || session.value?.accountId || state.value?.accountId || "");
const boundAccountLabel = computed(() => session.value?.accountId === state.value?.accountId
  ? session.value?.email || state.value?.accountId || ""
  : state.value?.accountId || "");
const stageTitle = computed(() => {
  switch (connectionStage.value) {
    case "origin-conflict": return t("settings.cloud.originConflictTitle");
    case "awaiting-sign-in": return t("settings.cloud.stage.awaitingSignIn");
    case "awaiting-binding": return t("settings.cloud.stage.awaitingBinding");
    case "signed-in-unbound": return t("settings.cloud.stage.signedInUnbound");
    case "active": return t("settings.cloud.stage.active");
    case "revoking": return t("settings.cloud.stage.revoking");
    case "conflict": return t("settings.cloud.stage.conflict");
    default: return t("settings.cloud.stage.signedOut");
  }
});
const stageDetail = computed(() => {
  switch (connectionStage.value) {
    case "origin-conflict": return t("settings.cloud.originConflictNote");
    case "awaiting-sign-in": return t("settings.cloud.stageDetail.awaitingSignIn");
    case "awaiting-binding": return t("settings.cloud.stageDetail.awaitingBinding");
    case "signed-in-unbound": return t("settings.cloud.stageDetail.signedInUnbound", { account: accountLabel.value });
    case "active": return t("settings.cloud.stageDetail.active", { account: boundAccountLabel.value });
    case "revoking": return t("settings.cloud.stageDetail.revoking");
    case "conflict": return t("settings.cloud.cloneConflict");
    default: return t("settings.cloud.stageDetail.signedOut");
  }
});
const pendingMessage = computed(() => waitingForSignIn.value
  ? t("settings.cloud.waitingSignIn")
  : t("settings.cloud.waitingBinding"));
const showConnectionActions = computed(() => ["signed-out", "signed-in-unbound", "revoking"].includes(connectionStage.value));
const canDisconnect = computed(() => Boolean(originConflict.value) || state.value?.status === "active" || state.value?.status === "clone-conflict");
const roleDraft = ref<string[]>([]);
const roleDraftInitialized = ref(false);
const savingRoles = ref(false);
const roleUpdateError = ref<{ code: string; message: string; details: string[] } | null>(null);
const stepUpOpen = ref(false);
const stepUpPassword = ref("");
const stepUpError = ref("");
const stepUpBusy = ref(false);
let settleStepUp: ((verified: boolean) => void) | undefined;
const rolesDirty = computed(() => {
  const settings = accessSettings.data.value;
  if (!settings) return false;
  const current = [...settings.availableRoleIds].sort();
  const draft = [...roleDraft.value].sort();
  return current.length !== draft.length || current.some((roleId, index) => roleId !== draft[index]);
});
const archivedDraftRoles = computed(() => {
  const roles = accessSettings.data.value?.roles ?? [];
  return roles.filter((role) => roleDraft.value.includes(role.roleId) && role.status === "archived");
});
const canSaveRoles = computed(() => Boolean(
  accessSettings.data.value
  && !busy.value
  && !savingRoles.value
  && rolesDirty.value
  && roleDraft.value.length > 0
  && archivedDraftRoles.value.length === 0,
));
const catalogPublicationLabel = computed(() => {
  const publication = state.value?.catalogPublication;
  if (!publication) return t("settings.cloud.rolesCatalogNotPublished");
  if (publication.status === "pending") return t("settings.cloud.rolesCatalogPending");
  if (publication.status === "failed") return t("settings.cloud.rolesCatalogFailed");
  return t("settings.cloud.rolesCatalogPublished", { time: publication.publishedAt ? formatDate(publication.publishedAt) : t("settings.cloud.rolesCatalogUnknownTime") });
});
const errorText = (error: unknown) => translateApiError(error, t, t("settings.cloud.loadFailed"));
const nodeMeta = (node: Node) => `${translateStatus(nodeRuntimeStatusKeys, node.status, t)} · ${translateStatus(nodeConnectionModeKeys, node.connectionMode, t)}`;
const nodeCloudHandle = (node: Node) => {
  if (node.connectionPath?.kind === "cloud-relay") return node.connectionPath.nodeHandle;
  const linkedHandle = node.labels[CLOUD_ACCOUNT_NODE_HANDLE_LABEL];
  if (linkedHandle) return linkedHandle;
  const addedHandle = addedCloudNodeHandles.value[node.id];
  if (addedHandle) return addedHandle;
  return nodeRelay.data.value?.channels.find((channel) => channel.nodeId === node.id && channel.connected)?.nodeHandle || "";
};
const nodeActionLabel = (node: Node) => {
  return addingNodeId.value === node.id ? t("settings.cloud.nodeAdding") : t("settings.cloud.nodeAdd");
};
const formatDate = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const reopen = (url?: string) => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };
const refresh = async () => { await Promise.all([account.refetch(), query.refetch()]); };
watch(() => accessSettings.data.value, (settings) => {
  if (!settings) return;
  if (!roleDraftInitialized.value || !rolesDirty.value) {
    roleDraft.value = [...settings.availableRoleIds];
    roleDraftInitialized.value = true;
  }
}, { immediate: true });
watch(() => state.value?.catalogPublication?.revision, (revision) => {
  if (!revision || state.value?.catalogPublication?.status !== "published" || revision === accessSettings.data.value?.catalogRevision) return;
  void accessSettings.refetch();
});
watch([signedIn, busy], async ([value, isBusy]) => {
  if (!value || isBusy) return;
  const intent = loginIntent.value;
  if (!intent) return;
  loginIntent.value = null;
  await query.refetch().catch(() => undefined);
  if (intent !== "bind") return;
  const status = state.value?.status;
  if (status !== "unbound" && status !== "pending-claim") return;
  await beginBinding();
});
watch(() => session.value?.pendingRequest?.requestId, async (current, previous) => {
  if (!previous || current) return;
  await query.refetch().catch(() => undefined);
  if (!signedIn.value) loginIntent.value = null;
});
function resetRoleDraft() {
  const settings = accessSettings.data.value;
  if (!settings || savingRoles.value) return;
  roleDraft.value = [...settings.availableRoleIds];
  roleDraftInitialized.value = true;
  roleUpdateError.value = null;
}
function toggleAvailableRole(roleId: string, available: boolean) {
  const settings = accessSettings.data.value;
  const role = settings?.roles.find((entry) => entry.roleId === roleId);
  if (!settings || savingRoles.value || !role || roleId === settings.ownerRoleId || (available && role.status === "archived")) return;
  roleDraft.value = available
    ? [...new Set([...roleDraft.value, roleId])]
    : roleDraft.value.filter((value) => value !== roleId);
  roleUpdateError.value = null;
}
function roleName(roleId: string) {
  return accessSettings.data.value?.roles.find((role) => role.roleId === roleId)?.name || roleId;
}
function roleUpdateFailure(error: unknown) {
  const code = error instanceof ApiError ? error.code : "ACCESS_ROLE_UPDATE_FAILED";
  const details = error instanceof ApiError ? error.details : undefined;
  if (code === "REVISION_CONFLICT") {
    return { code, message: t("settings.cloud.rolesRevisionConflict"), details: [] };
  }
  if (code === "CONTROL_PLANE_ACCESS_ROLE_IN_USE") {
    const roles = Array.isArray(details?.roles) ? details.roles as Array<Record<string, unknown>> : [];
    const lines = roles.map((entry) => {
      const name = roleName(String(entry.roleId ?? ""));
      if (entry.owner === true) return t("settings.cloud.rolesInUseOwner", { name });
      const grantees = Array.isArray(entry.grantees) ? entry.grantees as Array<Record<string, unknown>> : [];
      const emails = grantees.map((grantee) => String(grantee.email || grantee.accountId || "")).filter(Boolean).join(", ");
      return t("settings.cloud.rolesInUseShares", { name, count: Number(entry.activeShareCount || 0), grantees: emails || t("settings.cloud.rolesInUseHiddenGrantees") });
    });
    return { code, message: t("settings.cloud.rolesInUse"), details: lines };
  }
  if (code === "CONTROL_PLANE_ACCESS_ROLES_INVALID" && Array.isArray(details?.roleIds)) {
    return { code, message: t("settings.cloud.rolesUnavailableSelected"), details: (details.roleIds as unknown[]).map((roleId) => roleName(String(roleId))) };
  }
  return { code, message: errorText(error), details: [] };
}
function requestStepUp() {
  stepUpPassword.value = "";
  stepUpError.value = "";
  stepUpOpen.value = true;
  return new Promise<boolean>((resolve) => { settleStepUp = resolve; });
}
function finishStepUp(verified: boolean) {
  stepUpOpen.value = false;
  stepUpPassword.value = "";
  stepUpError.value = "";
  const resolve = settleStepUp;
  settleStepUp = undefined;
  resolve?.(verified);
}
function cancelStepUp() {
  if (!stepUpBusy.value) finishStepUp(false);
}
async function confirmStepUp() {
  if (!stepUpPassword.value || stepUpBusy.value) return;
  stepUpBusy.value = true;
  stepUpError.value = "";
  try {
    await stepUpControlPlaneAuthentication(stepUpPassword.value);
    finishStepUp(true);
  } catch (error) {
    if (error instanceof ApiError && error.code === "STEP_UP_REAUTHENTICATION_REQUIRED") {
      finishStepUp(false);
      roleUpdateError.value = { code: error.code, message: t("settings.cloud.rolesReauthenticationRequired"), details: [] };
      return;
    }
    stepUpError.value = errorText(error);
  } finally {
    stepUpBusy.value = false;
  }
}
async function persistAvailableRoles() {
  const settings = accessSettings.data.value;
  if (!settings) throw new Error(t("settings.cloud.rolesLoadFailed"));
  const updated = await updateCloudAvailableRoles({ expectedSettingsRevision: settings.settingsRevision, availableRoleIds: roleDraft.value });
  roleDraft.value = [...updated.availableRoleIds];
  roleDraftInitialized.value = true;
  await Promise.all([accessSettings.refetch(), query.refetch()]);
  showControlPlaneToast(t("settings.cloud.rolesSavedToast"), "success");
}
async function saveAvailableRoles() {
  if (!canSaveRoles.value) return;
  savingRoles.value = true;
  roleUpdateError.value = null;
  try {
    try {
      await persistAvailableRoles();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "STEP_UP_REQUIRED") throw error;
      if (!(await requestStepUp())) return;
      await persistAvailableRoles();
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === "STEP_UP_REAUTHENTICATION_REQUIRED") {
      roleUpdateError.value = { code: error.code, message: t("settings.cloud.rolesReauthenticationRequired"), details: [] };
      return;
    }
    roleUpdateError.value = roleUpdateFailure(error);
    if (roleUpdateError.value.code === "REVISION_CONFLICT") await accessSettings.refetch().catch(() => undefined);
  } finally {
    savingRoles.value = false;
  }
}
async function signIn(intent: LoginIntent) {
  if (busy.value) return;
  loginIntent.value = intent;
  pendingAction.value = "sign-in";
  try {
    const request = await createCloudSignInRequest();
    reopen(request.authorizationUrl);
    await refresh();
  } catch (error) {
    loginIntent.value = null;
    showControlPlaneToast(errorText(error), "error");
  } finally {
    pendingAction.value = null;
  }
}
async function signOut() {
  if (busy.value) return;
  signOutOpen.value = false;
  loginIntent.value = null;
  pendingAction.value = "sign-out";
  try {
    await signOutCloudAccount();
    await refresh();
  } catch (error) {
    showControlPlaneToast(errorText(error), "error");
  } finally {
    pendingAction.value = null;
  }
}
async function beginBinding() {
  if (busy.value) return;
  pendingAction.value = "bind";
  try {
    const request = await createCloudBindingRequest();
    reopen(request.authorizationUrl);
    await refresh();
  } catch (error) {
    showControlPlaneToast(errorText(error), "error");
  } finally {
    pendingAction.value = null;
  }
}
async function setDeviceAccess(enabled: boolean) {
  if (busy.value || state.value?.status !== "active" || enabled === state.value.scopes.deviceAccess) return;
  pendingAction.value = "device-access";
  try {
    await updateCloudRemoteAccess(enabled);
    await query.refetch();
  } catch (error) {
    showControlPlaneToast(errorText(error), "error");
  } finally {
    pendingAction.value = null;
  }
}
async function addNode(node: Node) {
  if (addingNodeId.value || busy.value || !canAddCloudNodes.value || nodeCloudHandle(node)) return;
  addingNodeId.value = node.id;
  try {
    const result = await bindCloudRelayNode(node.id);
    if (!result.bound) throw new Error(t("settings.cloud.nodeAddFailed"));
    if (result.nodeHandle) {
      addedCloudNodeHandles.value = { ...addedCloudNodeHandles.value, [node.id]: result.nodeHandle };
    }
    showControlPlaneToast(t("settings.cloud.nodeAddDone", { name: node.name }), "success");
    await Promise.all([nodeRelay.refetch(), nodes.refetch()]);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("settings.cloud.nodeAddFailed")), "error");
  } finally {
    addingNodeId.value = "";
  }
}
async function performDisconnect() {
  if (busy.value) return;
  pendingAction.value = "disconnect";
  try {
    if (originConflict.value) await resetConflictingCloudBinding();
    else await disconnectCloudAccount();
    await Promise.all([query.refetch(), account.refetch()]);
  } catch (error) {
    showControlPlaneToast(errorText(error), "error");
  } finally {
    pendingAction.value = null;
  }
}
async function disconnect() {
  disconnectOpen.value = false;
  await performDisconnect();
}
async function retryRevocation() {
  await performDisconnect();
}
</script>

<style scoped>
.cloud-origin-conflict{display:grid;gap:4px;overflow-wrap:anywhere}.cloud-origin-conflict p{margin:0}.cloud-origin-conflict code{font-size:12px}
.cloud-connectivity-scroll{height:100%;min-height:0;width:100%}.cloud-connectivity-page{display:grid;gap:12px;min-width:0}.cloud-tabs{max-width:100%;min-width:0}.cloud-tabs-list{align-self:start;background:var(--surface-inset);border:1px solid var(--line);border-radius:7px;gap:1px;height:32px;justify-self:start;max-width:100%;min-height:32px;overflow-x:auto;padding:2px;scrollbar-width:none;width:fit-content}.cloud-tabs-list::-webkit-scrollbar{display:none}.cloud-tabs-list :deep(button){border-radius:5px;color:var(--text-muted);flex:0 0 auto;font-size:12px;font-weight:500;height:26px;min-height:26px;padding:0 10px}.cloud-tabs-list :deep(button:not([data-state="active"]):hover){background:var(--surface-hover);color:var(--text-strong)}.cloud-tabs-list :deep(button[data-state="active"]){background:var(--surface-active);color:var(--text-strong);box-shadow:none}.cloud-page-head{align-items:center;display:flex;gap:16px;justify-content:space-between}.cloud-page-head p{color:var(--text-muted);font-size:12px;line-height:1.45;margin:0}.cloud-directory{background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;overflow:hidden}.cloud-directory-head{align-items:center;border-bottom:1px solid var(--line);display:flex;min-height:38px;padding:0 12px}.cloud-directory-head strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-content{display:grid;gap:14px;padding:12px}.cloud-state{color:var(--text-muted);font-size:12px;padding:48px 20px;text-align:center}.cloud-error{align-items:center;color:var(--status-danger);display:flex;font-size:12px;justify-content:space-between;min-height:80px;padding:12px}.cloud-identity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0}.cloud-identity>div{display:grid;gap:4px;min-width:0;padding:8px 10px}.cloud-identity dt{color:var(--text-muted);font-size:12px}.cloud-identity dd{color:var(--text);font-size:13px;margin:0;min-width:0;overflow-wrap:anywhere}.cloud-identity code{font-size:12px}.cloud-pending{background:var(--surface-active);border:1px solid var(--line);border-radius:8px;color:var(--text);font-size:12px;margin:0;padding:10px 12px}.cloud-link{background:none;border:0;color:var(--brand-accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline}.cloud-warning{color:var(--status-warning);font-size:12px;margin:0}@media(max-width:720px){.cloud-page-head{align-items:stretch;flex-direction:column}.cloud-page-head>span{align-self:flex-start}.cloud-identity{grid-template-columns:1fr}}
.cloud-node-picker-head{gap:12px;padding:9px 12px}.cloud-node-picker-head>span{display:grid;gap:2px;min-width:0}.cloud-node-picker-head strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-node-picker-head small{color:var(--text-muted);font-size:12px;line-height:1.45}.cloud-node-picker-head>small{flex:0 0 auto}.cloud-node-picker-warning{align-items:center;border-bottom:1px solid var(--line);color:var(--status-warning);display:flex;flex-wrap:wrap;font-size:12px;gap:8px 12px;justify-content:space-between;line-height:1.45;margin:0;padding:9px 12px}.cloud-node-picker-state{color:var(--text-muted);font-size:12px;margin:0;padding:48px 20px;text-align:center}.cloud-node-picker-error{align-items:center;color:var(--status-danger);display:flex;font-size:12px;gap:12px;justify-content:space-between;padding:12px}.cloud-node-picker-list{display:grid}.cloud-node-row{align-items:center;appearance:none;background:transparent;border:0;border-bottom:1px solid var(--line);color:inherit;cursor:pointer;display:grid;gap:16px;grid-template-columns:minmax(0,1fr) auto;padding:12px;text-align:left;width:100%}.cloud-node-row:last-child{border-bottom:0}.cloud-node-row:not(:disabled):hover{background:var(--surface-hover)}.cloud-node-row:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}.cloud-node-row:disabled{cursor:default}.cloud-node-identity{display:grid;gap:3px;min-width:0}.cloud-node-identity strong,.cloud-node-identity small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cloud-node-identity strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-node-identity small{color:var(--text-muted);font-size:12px}.cloud-node-action{align-items:center;color:var(--brand-accent);display:inline-flex;font-size:12px;font-weight:500;gap:6px;white-space:nowrap}.cloud-node-row:disabled .cloud-node-action{color:var(--text-muted)}@media(max-width:560px){.cloud-node-row{gap:7px;grid-template-columns:1fr}.cloud-node-action{justify-self:start}}
.cloud-directory-head{gap:8px;justify-content:space-between}.cloud-revision,.cloud-catalog-meta{color:var(--text-muted);font-size:12px}.cloud-revision{white-space:nowrap}.cloud-catalog-meta{align-items:center;display:flex;flex-wrap:wrap;gap:4px 12px}.cloud-role-publication-error code,.cloud-role-error code{font-size:12px}.cloud-role-list{display:grid}.cloud-role-row{align-items:center;display:grid;gap:10px;grid-template-columns:auto minmax(0,1fr) auto;padding:12px;border-bottom:1px solid var(--line)}.cloud-role-row:last-child{border-bottom:0}.cloud-role-row[data-archived="true"]{background:var(--surface-inset)}.cloud-role-copy{display:grid;gap:3px;min-width:0}.cloud-role-title{align-items:center;display:flex;flex-wrap:wrap;gap:6px}.cloud-role-title strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-role-copy small{color:var(--text-muted);font-size:12px;line-height:1.45}.cloud-role-copy code{color:var(--text-muted);font-size:12px;overflow-wrap:anywhere}.cloud-role-state{color:var(--text-muted);font-size:12px;white-space:nowrap}.cloud-role-actions{align-items:center;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}.cloud-role-dirty{color:var(--text-muted);font-size:12px;margin-right:auto}.cloud-role-error{background:color-mix(in srgb,var(--status-danger) 7%,transparent);border:1px solid color-mix(in srgb,var(--status-danger) 24%,var(--line));border-radius:7px;color:var(--status-danger);display:grid;gap:6px;font-size:12px;padding:10px 12px}.cloud-role-error strong{font-weight:500}.cloud-role-error ul{display:grid;gap:3px;margin:0;padding-left:18px}.cloud-role-error code{color:var(--text-muted)}.cloud-step-up-dialog{max-width:480px}.cloud-step-up-form{display:grid;gap:14px}.cloud-step-up-field{display:grid;gap:6px;font-size:12px}.cloud-step-up-field span{color:var(--text-muted)}@media(max-width:620px){.cloud-role-row{align-items:start;grid-template-columns:auto minmax(0,1fr)}.cloud-role-state{grid-column:2}.cloud-role-actions{align-items:stretch}.cloud-role-dirty{flex-basis:100%;margin:0}.cloud-directory-head{align-items:flex-start;flex-direction:column;justify-content:center;padding-block:9px}.cloud-revision{white-space:normal}}
.cloud-connection-overview,
.cloud-account-row,
.cloud-danger {
  align-items: center;
  display: flex;
  gap: 12px 24px;
  justify-content: space-between;
}

.cloud-summary,
.cloud-setting-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.cloud-summary strong,
.cloud-setting-copy strong,
.cloud-scope strong,
.cloud-subsection-head strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.cloud-summary span,
.cloud-account-email,
.cloud-hint,
.cloud-scope small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  margin: 0;
  overflow-wrap: anywhere;
}

.cloud-account-email {
  color: var(--text);
  font-size: 13px;
}

.cloud-pending {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cloud-account-row,
.cloud-subsection,
.cloud-advanced {
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.cloud-subsection {
  display: grid;
  gap: 8px;
}

.cloud-scope {
  align-items: center;
  cursor: pointer;
  display: flex;
  gap: 16px;
  justify-content: space-between;
  min-height: 36px;
}

.cloud-scope > span {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.cloud-connection-actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 8px;
}

.cloud-account-row > :deep(button),
.cloud-danger > :deep(button) {
  flex-shrink: 0;
}

.cloud-advanced summary {
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
}

.cloud-advanced summary:hover,
.cloud-advanced[open] summary {
  color: var(--text-strong);
}

.cloud-advanced summary:focus-visible {
  border-radius: 4px;
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.cloud-advanced[open] summary {
  margin-bottom: 8px;
}

.cloud-advanced .cloud-identity {
  gap: 12px 24px;
}

.cloud-advanced .cloud-identity > div {
  padding: 0;
}

.cloud-danger {
  padding: 12px;
}

@media (max-width: 620px) {
  .cloud-connection-overview,
  .cloud-account-row,
  .cloud-danger {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  .cloud-connection-actions {
    flex-shrink: 1;
  }
}
</style>
