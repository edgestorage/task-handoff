<template>
  <ScrollArea class="cloud-connectivity-scroll settings-page-scroll" :horizontal="false">
    <div class="cloud-connectivity-page settings-content-page">
      <header class="cloud-page-head">
        <p>{{ t("settings.cloud.description") }}</p>
        <Badge :variant="state?.status === 'active' ? 'default' : 'secondary'">{{ statusLabel }}</Badge>
      </header>
      <p v-if="requestFailure" class="cloud-warning" role="alert">
        {{ requestFailureMessage }}
        <code>{{ requestFailure.code }}</code>
      </p>

      <section class="cloud-directory">
        <header class="cloud-directory-head"><strong>{{ t("settings.cloud.accountTitle") }}</strong></header>
        <div v-if="account.error.value" class="cloud-error" role="alert"><span>{{ errorText(account.error.value) }}</span><Button variant="outline" size="sm" @click="account.refetch()">{{ t("common.actions.retry") }}</Button></div>
        <div v-else-if="account.isLoading.value" class="cloud-state" role="status">{{ t("settings.cloud.loading") }}</div>
        <div v-else class="cloud-content">
          <p class="cloud-note">{{ t("settings.cloud.accountNote") }}</p>
          <p v-if="reauthRequired && !waitingForSignIn" class="cloud-warning" role="alert">{{ t("settings.cloud.sessionExpired") }}</p>
          <dl v-if="signedIn" class="cloud-identity">
            <div><dt>{{ t("settings.cloud.accountEmail") }}</dt><dd>{{ session?.email || session?.accountId }}</dd></div>
            <div v-if="session?.sessionExpiresAt"><dt>{{ t("settings.cloud.accountExpires") }}</dt><dd>{{ formatDate(session.sessionExpiresAt) }}</dd></div>
          </dl>
          <p v-if="waitingForSignIn" class="cloud-pending" role="status">
            {{ t("settings.cloud.waitingSignIn") }}
            <button type="button" class="cloud-link" @click="reopen(pendingUrl)">{{ t("settings.cloud.reopen") }}</button>
          </p>
          <div class="cloud-actions">
            <Button v-if="!signedIn && !waitingForSignIn" :disabled="busy" @click="signIn">{{ busy ? t("settings.cloud.opening") : t("settings.cloud.signIn") }}</Button>
            <Button v-if="signedIn" variant="outline" :disabled="busy" @click="signOut">{{ t("settings.cloud.signOut") }}</Button>
          </div>
        </div>
      </section>

      <section class="cloud-directory">
        <header class="cloud-directory-head"><strong>{{ t("settings.cloud.relayTitle") }}</strong></header>
        <div v-if="query.isLoading.value" class="cloud-state" role="status">{{ t("settings.cloud.loading") }}</div>
        <div v-else-if="query.error.value" class="cloud-error" role="alert"><span>{{ errorText(query.error.value) }}</span><Button variant="outline" size="sm" @click="query.refetch()">{{ t("common.actions.retry") }}</Button></div>
        <div v-else-if="state" class="cloud-content">
          <dl class="cloud-identity">
            <div><dt>{{ t("settings.cloud.controlPlaneId") }}</dt><dd>{{ state.identity.controlPlaneId }}</dd></div>
            <div v-if="state.cloudControlPlaneId"><dt>{{ t("settings.cloud.cloudControlPlaneId") }}</dt><dd>{{ state.cloudControlPlaneId }}</dd></div>
            <div><dt>{{ t("settings.cloud.fingerprint") }}</dt><dd><code>{{ state.identity.fingerprint }}</code></dd></div>
            <div v-if="state.bindingRevision"><dt>{{ t("settings.cloud.revision") }}</dt><dd>{{ state.bindingRevision }}</dd></div>
            <div v-if="state.accountId"><dt>{{ t("settings.cloud.boundAccount") }}</dt><dd>{{ session?.email || state.accountId }}</dd></div>
            <div><dt>{{ t("settings.cloud.background") }}</dt><dd>{{ state.hasBackgroundCredential ? t("settings.cloud.running") : t("settings.cloud.notConnected") }}</dd></div>
          </dl>
          <p class="cloud-note">{{ t("settings.cloud.backgroundNote") }}</p>
          <p v-if="!signedIn && (state.status === 'unbound' || state.status === 'pending-claim')" class="cloud-warning" role="status">{{ t("settings.cloud.signInFirst") }}</p>
          <p v-else-if="waitingForBinding" class="cloud-pending" role="status">
            {{ t("settings.cloud.waitingBinding") }}
            <button type="button" class="cloud-link" @click="reopen(pendingUrl)">{{ t("settings.cloud.reopen") }}</button>
          </p>
          <div class="cloud-actions">
            <Button v-if="signedIn && (state.status === 'unbound' || state.status === 'pending-claim')" :disabled="busy || waitingForBinding" @click="beginBinding">{{ busy ? t("settings.cloud.opening") : t("settings.cloud.connect") }}</Button>
            <Button v-if="state.status !== 'unbound'" variant="destructive" :disabled="busy" @click="disconnect">{{ t("settings.cloud.disconnect") }}</Button>
          </div>
          <p v-if="state.remoteResult === 'unknown' || state.status === 'pending-revocation'" class="cloud-warning" role="status">{{ t("settings.cloud.resultUnknown") }}</p>
          <p v-if="state.status === 'clone-conflict'" class="cloud-warning" role="alert">{{ t("settings.cloud.cloneConflict") }}</p>
        </div>
      </section>

      <section v-if="state?.status === 'active'" class="cloud-directory">
        <header class="cloud-directory-head"><strong>{{ t("settings.cloud.scopesTitle") }}</strong></header>
        <div class="cloud-content">
          <p class="cloud-note">{{ t("settings.cloud.scopesNote") }}</p>
          <label class="cloud-scope">
            <Checkbox :model-value="state.scopes.deviceAccess" :disabled="busy" @update:model-value="(value) => setScope('deviceAccess', value === true)" />
            <span><strong>{{ t("settings.cloud.deviceAccess") }}</strong><small>{{ t("settings.cloud.deviceAccessHint") }}</small></span>
          </label>
          <label class="cloud-scope">
            <Checkbox :model-value="state.scopes.nodeRelay" :disabled="busy" @update:model-value="(value) => setScope('nodeRelay', value === true)" />
            <span><strong>{{ t("settings.cloud.nodeRelay") }}</strong><small>{{ t("settings.cloud.nodeRelayHint") }}</small></span>
          </label>
          <section class="cloud-node-picker" :aria-label="t('settings.cloud.nodeListTitle')">
            <header class="cloud-node-picker-head">
              <span>
                <strong>{{ t("settings.cloud.nodeListTitle") }}</strong>
                <small>{{ t("settings.cloud.nodeListHint") }}</small>
              </span>
              <small>{{ t("settings.cloud.nodeListCount", { count: cloudNodes.length }) }}</small>
            </header>
            <p v-if="!canAddCloudNodes" class="cloud-node-picker-warning" role="status">
              {{ signedIn ? t("settings.cloud.nodeAddRequiresBinding") : t("settings.cloud.nodeAddRequiresSignIn") }}
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
          <p v-if="!state.scopes.nodeRelay" class="cloud-note" role="status">{{ t("settings.cloud.nodeRelayOffNote") }}</p>
          <p v-if="!state.scopes.deviceAccess" class="cloud-note" role="status">{{ t("settings.cloud.deviceAccessOffNote") }}</p>
          <p v-if="!state.scopes.deviceAccess && !state.scopes.nodeRelay" class="cloud-warning" role="status">{{ t("settings.cloud.bothScopesOffNote") }}</p>
          <p class="cloud-note">{{ t("settings.cloud.unbindClearsScopes") }}</p>
        </div>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Cloud } from "@lucide/vue";
import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL } from "@task-handoff/protocol/control-plane";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { bindCloudRelayNode, createCloudBindingRequest, createCloudSignInRequest, disconnectCloudAccount, signOutCloudAccount, updateCloudScopes, useCloudAccountQuery, useCloudConnectivityQuery, useCloudNodeRelayQuery, useNodesQuery } from "../../../api/queries";
import type { Node } from "../../../api/types";
import { translateApiError } from "../../../i18n/apiError";
import { nodeConnectionModeKeys, nodeRuntimeStatusKeys, translateStatus } from "../../../i18n/status";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const { locale, t } = useI18n();
const query = useCloudConnectivityQuery();
const account = useCloudAccountQuery();
const nodes = useNodesQuery();
const busy = ref(false);
const addingNodeId = ref("");
const addedCloudNodeHandles = ref<Record<string, string>>({});
const state = computed(() => query.data.value);
const session = computed(() => account.data.value);
const signedIn = computed(() => Boolean(session.value?.signedIn));
const reauthRequired = computed(() => Boolean(session.value?.reauthRequired));
const cloudNodes = computed(() => nodes.data.value || []);
const canAddCloudNodes = computed(() => signedIn.value && state.value?.status === "active");
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
const statusLabel = computed(() => state.value ? t(`settings.cloud.status.${state.value.status}`) : "");
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
  if (addingNodeId.value === node.id) return state.value?.scopes.nodeRelay
    ? t("settings.cloud.nodeAdding")
    : t("settings.cloud.nodeAddAndEnabling");
  return state.value?.scopes.nodeRelay
    ? t("settings.cloud.nodeAdd")
    : t("settings.cloud.nodeAddAndEnable");
};
const formatDate = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const reopen = (url?: string) => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };
const refresh = async () => { await Promise.all([account.refetch(), query.refetch()]); };
async function signIn() { busy.value = true; try { const request = await createCloudSignInRequest(); reopen(request.authorizationUrl); await refresh(); } catch (error) { showControlPlaneToast(errorText(error), "error"); } finally { busy.value = false; } }
async function signOut() { if (!window.confirm(t("settings.cloud.signOutConfirm"))) return; busy.value = true; try { await signOutCloudAccount(); await refresh(); } catch (error) { showControlPlaneToast(errorText(error), "error"); } finally { busy.value = false; } }
async function beginBinding() { busy.value = true; try { const request = await createCloudBindingRequest(); reopen(request.authorizationUrl); await refresh(); } catch (error) { showControlPlaneToast(errorText(error), "error"); } finally { busy.value = false; } }
async function setScope(scope: "deviceAccess" | "nodeRelay", enabled: boolean) { busy.value = true; try { await updateCloudScopes({ ...state.value!.scopes, [scope]: enabled }); await query.refetch(); } catch (error) { showControlPlaneToast(errorText(error), "error"); } finally { busy.value = false; } }
async function addNode(node: Node) {
  if (addingNodeId.value || busy.value || !canAddCloudNodes.value || nodeCloudHandle(node)) return;
  const enablingScope = state.value?.scopes.nodeRelay !== true;
  addingNodeId.value = node.id;
  try {
    if (enablingScope) {
      await updateCloudScopes({ ...state.value!.scopes, nodeRelay: true });
      await query.refetch();
    }
    const result = await bindCloudRelayNode(node.id);
    if (!result.bound) throw new Error(t("settings.cloud.nodeAddFailed"));
    if (result.nodeHandle) {
      addedCloudNodeHandles.value = { ...addedCloudNodeHandles.value, [node.id]: result.nodeHandle };
    }
    showControlPlaneToast(t("settings.cloud.nodeAddDone", { name: node.name }), "success");
    await Promise.all([nodeRelay.refetch(), nodes.refetch()]);
  } catch (error) {
    if (enablingScope) await query.refetch().catch(() => undefined);
    showControlPlaneToast(translateApiError(error, t, t("settings.cloud.nodeAddFailed")), "error");
  } finally {
    addingNodeId.value = "";
  }
}
async function disconnect() { if (!window.confirm(t("settings.cloud.disconnectConfirm"))) return; busy.value = true; try { await disconnectCloudAccount(); await query.refetch(); } catch (error) { showControlPlaneToast(errorText(error), "error"); } finally { busy.value = false; } }
</script>

<style scoped>
.cloud-connectivity-scroll{height:100%;min-height:0;width:100%}.cloud-connectivity-page{display:grid;gap:12px}.cloud-page-head{align-items:center;display:flex;gap:16px;justify-content:space-between}.cloud-page-head p,.cloud-note{color:var(--text-muted);font-size:12px;line-height:1.45;margin:0}.cloud-scope{align-items:flex-start;cursor:pointer;display:flex;gap:10px}.cloud-scope span{display:grid;gap:2px}.cloud-scope strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-scope small{color:var(--text-muted);font-size:12px;line-height:1.45}.cloud-directory{background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;overflow:hidden}.cloud-directory-head{align-items:center;border-bottom:1px solid var(--line);display:flex;min-height:38px;padding:0 12px}.cloud-directory-head strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-content{display:grid;gap:14px;padding:12px}.cloud-state{color:var(--text-muted);font-size:12px;padding:48px 20px;text-align:center}.cloud-error{align-items:center;color:var(--status-danger);display:flex;font-size:12px;justify-content:space-between;min-height:80px;padding:12px}.cloud-identity{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0}.cloud-identity>div{display:grid;gap:4px;min-width:0;padding:8px 10px}.cloud-identity dt{color:var(--text-muted);font-size:12px}.cloud-identity dd{color:var(--text);font-size:13px;margin:0;min-width:0;overflow-wrap:anywhere}.cloud-identity code{font-size:12px}.cloud-note{background:var(--surface-inset);border:1px solid var(--line);border-radius:7px;padding:10px 12px}.cloud-pending{background:var(--surface-active);border:1px solid var(--line);border-radius:8px;color:var(--text);font-size:12px;margin:0;padding:10px 12px}.cloud-link{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline}.cloud-actions{border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;padding-top:12px}.cloud-warning{color:var(--status-warning);font-size:12px;margin:0}@media(max-width:720px){.cloud-page-head{align-items:stretch;flex-direction:column}.cloud-page-head>span{align-self:flex-start}.cloud-identity{grid-template-columns:1fr}}
.cloud-node-picker{display:grid;border:1px solid var(--line);border-radius:7px;overflow:hidden}.cloud-node-picker-head{align-items:center;background:var(--surface-inset);border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;padding:9px 10px}.cloud-node-picker-head>span{display:grid;gap:2px;min-width:0}.cloud-node-picker-head strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-node-picker-head small{color:var(--text-muted);font-size:12px;line-height:1.45}.cloud-node-picker-head>small{flex:0 0 auto}.cloud-node-picker-warning{border-bottom:1px solid var(--line);color:var(--status-warning);font-size:12px;line-height:1.45;margin:0;padding:9px 10px}.cloud-node-picker-state{color:var(--text-muted);font-size:12px;margin:0;padding:12px 10px;text-align:center}.cloud-node-picker-error{align-items:center;color:var(--status-danger);display:flex;font-size:12px;gap:12px;justify-content:space-between;padding:10px}.cloud-node-picker-list{display:grid}.cloud-node-row{align-items:center;appearance:none;background:transparent;border:0;border-bottom:1px solid var(--line);color:inherit;cursor:pointer;display:grid;gap:16px;grid-template-columns:minmax(0,1fr) auto;padding:10px;text-align:left;width:100%}.cloud-node-row:last-child{border-bottom:0}.cloud-node-row:not(:disabled):hover{background:var(--surface-hover)}.cloud-node-row:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}.cloud-node-row:disabled{cursor:default}.cloud-node-identity{display:grid;gap:3px;min-width:0}.cloud-node-identity strong,.cloud-node-identity small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cloud-node-identity strong{color:var(--text-strong);font-size:13px;font-weight:500}.cloud-node-identity small{color:var(--text-muted);font-size:12px}.cloud-node-action{align-items:center;color:var(--accent);display:inline-flex;font-size:12px;font-weight:500;gap:6px;white-space:nowrap}.cloud-node-row:disabled .cloud-node-action{color:var(--text-muted)}@media(max-width:560px){.cloud-node-row{gap:7px;grid-template-columns:1fr}.cloud-node-action{justify-self:start}}
</style>
