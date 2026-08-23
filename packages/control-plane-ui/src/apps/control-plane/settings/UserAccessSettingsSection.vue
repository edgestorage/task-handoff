<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="settings-section-scroll-content user-access-settings">
      <section class="modal-section settings-panel-surface user-access-panel">
        <header class="user-access-head">
          <div>
            <strong>{{ t("settings.userAccess.title") }}</strong>
            <p>{{ t("settings.userAccess.description") }}</p>
          </div>
          <Button variant="outline" size="sm" :disabled="users.isFetching.value || loadingDetails" @click="refresh">
            <RefreshCw :class="{ spinning: users.isFetching.value || loadingDetails }" :size="14" />
            <span>{{ t("common.actions.refresh") }}</span>
          </Button>
        </header>

        <form class="create-user-form" @submit.prevent="createUser">
          <label><span>{{ t("settings.userAccess.displayName") }}</span><Input v-model="draft.displayName" autocomplete="name" /></label>
          <label><span>{{ t("settings.userAccess.username") }}</span><Input v-model="draft.username" autocomplete="username" /></label>
          <label><span>{{ t("settings.userAccess.password") }}</span><Input v-model="draft.password" type="password" autocomplete="new-password" /></label>
          <label>
            <span>{{ t("settings.userAccess.role") }}</span>
            <ControlPlaneSelect v-model="draft.roleId">
              <ControlPlaneSelectItem v-for="role in activeRoles" :key="role.id" :value="role.id">{{ role.name }}</ControlPlaneSelectItem>
            </ControlPlaneSelect>
          </label>
          <div class="create-user-actions">
            <Button type="submit" :disabled="creating || !canCreate"><UserPlus :size="14" /><span>{{ creating ? t("settings.userAccess.creating") : t("settings.userAccess.create") }}</span></Button>
          </div>
        </form>

        <p v-if="users.isLoading.value || roles.isLoading.value" class="user-access-state">{{ t("settings.userAccess.loading") }}</p>
        <p v-else-if="users.error.value || roles.error.value" class="user-access-error" role="alert">{{ errorText(users.error.value || roles.error.value) }}</p>
        <p v-else-if="!users.data.value?.length" class="user-access-state">{{ t("settings.userAccess.empty") }}</p>
        <div v-else class="user-list">
          <article v-for="user in users.data.value" :key="user.id" class="user-row">
            <div class="user-identity">
              <div><strong>{{ user.displayName }}</strong><span class="status" :data-status="user.status">{{ statusLabel(user.status) }}</span></div>
              <code>{{ user.primaryUsername || user.id }}</code>
            </div>

            <template v-if="details[user.id]">
              <label class="compact-field">
                <span>{{ t("settings.userAccess.role") }}</span>
                <ControlPlaneSelect :model-value="details[user.id].accessGrant.roleIds[0]" :disabled="busyId === user.id" @update:model-value="(value) => updateRole(user.id, value)">
                  <ControlPlaneSelectItem v-for="role in activeRoles" :key="role.id" :value="role.id">{{ role.name }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
              </label>
              <div class="node-scope">
                <label class="node-option">
                  <Checkbox :model-value="details[user.id].accessGrant.nodeScope.kind === 'all'" :disabled="busyId === user.id" @update:model-value="(value) => setAllNodes(user.id, value === true)" />
                  <span>{{ t("settings.userAccess.allNodes") }}</span>
                </label>
                <template v-if="details[user.id].accessGrant.nodeScope.kind === 'selected'">
                  <label v-for="node in nodes" :key="node.id" class="node-option">
                    <Checkbox :model-value="hasNode(user.id, node.id)" :disabled="busyId === user.id" @update:model-value="(value) => toggleNode(user.id, node.id, value === true)" />
                    <span>{{ node.name }}</span>
                  </label>
                </template>
              </div>
            </template>
            <span v-else class="user-access-state">{{ t("settings.userAccess.loadingAccess") }}</span>

            <div class="user-actions">
              <Button v-if="user.status !== 'archived'" variant="outline" size="sm" :disabled="Boolean(busyId)" @click="toggleStatus(user.id, user.status)">
                <UserCheck v-if="user.status === 'disabled'" :size="14" /><UserX v-else :size="14" />
                <span>{{ user.status === "disabled" ? t("settings.userAccess.enable") : t("settings.userAccess.disable") }}</span>
              </Button>
              <Button v-if="user.status !== 'archived'" variant="outline" size="sm" :disabled="Boolean(busyId)" @click="archiveUser(user.id)">
                <Archive :size="14" /><span>{{ t("settings.userAccess.archive") }}</span>
              </Button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, RefreshCw, UserCheck, UserPlus, UserX } from "@lucide/vue";
import type { ControlPlaneUserDetail } from "@task-handoff/protocol/control-plane-access";
import type { Node } from "../../../api/types";
import { createControlPlaneUser, getControlPlaneUserDetail, setControlPlaneUserAccess, updateControlPlaneUser, useRolesQuery, useUsersQuery } from "../../../api/queries";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ nodes: Node[] }>();
const { t } = useI18n();
const users = useUsersQuery();
const roles = useRolesQuery();
const details = reactive<Record<string, ControlPlaneUserDetail>>({});
const loadingDetails = ref(false);
const creating = ref(false);
const busyId = ref("");
const draft = reactive({ displayName: "", username: "", password: "", roleId: "role_operator" });
const activeRoles = computed(() => (roles.data.value || []).filter((role) => role.status === "active"));
type UserStatus = ControlPlaneUserDetail["status"];
const canCreate = computed(() => draft.displayName.trim() && draft.username.trim() && draft.password.length >= 8 && draft.roleId);
const errorText = (error: unknown) => translateApiError(error, t, t("settings.userAccess.failed"));
const statusLabel = (status: UserStatus) => t(`settings.userAccess.status.${status}`);
const hasNode = (userId: string, nodeId: string) => {
  const scope = details[userId]?.accessGrant.nodeScope;
  return scope?.kind === "selected" && scope.nodeIds.includes(nodeId);
};

async function loadDetails() {
  const current = users.data.value || [];
  loadingDetails.value = true;
  try {
    const loaded = await Promise.all(current.map((user) => getControlPlaneUserDetail(user.id)));
    for (const detail of loaded) details[detail.id] = detail;
    for (const id of Object.keys(details)) if (!current.some((user) => user.id === id)) delete details[id];
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    loadingDetails.value = false;
  }
}

watch(() => users.data.value?.map((user) => `${user.id}:${user.updatedAt}`).join("|"), () => { void loadDetails(); }, { immediate: true });

async function refresh() {
  await Promise.all([users.refetch(), roles.refetch()]);
  await loadDetails();
}

async function createUser() {
  if (!canCreate.value) return;
  creating.value = true;
  try {
    await createControlPlaneUser({ username: draft.username, password: draft.password, displayName: draft.displayName, roleIds: [draft.roleId], nodeScope: { kind: "all" }, requirePasswordChange: true });
    Object.assign(draft, { displayName: "", username: "", password: "", roleId: "role_operator" });
    await refresh();
    showControlPlaneToast(t("settings.userAccess.created"), "success");
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    creating.value = false;
  }
}

async function mutateAccess(userId: string, roleIds: string[], nodeScope: ControlPlaneUserDetail["accessGrant"]["nodeScope"]) {
  const detail = details[userId];
  if (!detail) return;
  busyId.value = userId;
  try {
    details[userId] = await setControlPlaneUserAccess(userId, { roleIds, nodeScope, expectedAuthorizationRevision: detail.accessGrant.authorizationRevision });
    await users.refetch();
  } catch (error) {
    showControlPlaneToast(errorText(error));
    await loadDetails();
  } finally {
    busyId.value = "";
  }
}

function updateRole(userId: string, value: unknown) {
  if (typeof value !== "string" || !activeRoles.value.some((role) => role.id === value)) return;
  const detail = details[userId];
  if (detail) void mutateAccess(userId, [value], detail.accessGrant.nodeScope);
}

function setAllNodes(userId: string, checked: boolean) {
  const detail = details[userId];
  if (!detail) return;
  void mutateAccess(userId, detail.accessGrant.roleIds, checked ? { kind: "all" } : { kind: "selected", nodeIds: [] });
}

function toggleNode(userId: string, nodeId: string, checked: boolean) {
  const detail = details[userId];
  if (!detail || detail.accessGrant.nodeScope.kind !== "selected") return;
  const nodeIds = checked ? [...new Set([...detail.accessGrant.nodeScope.nodeIds, nodeId])] : detail.accessGrant.nodeScope.nodeIds.filter((id) => id !== nodeId);
  void mutateAccess(userId, detail.accessGrant.roleIds, { kind: "selected", nodeIds });
}

async function updateStatus(userId: string, status: UserStatus) {
  busyId.value = userId;
  try {
    details[userId] = await updateControlPlaneUser(userId, { status });
    await users.refetch();
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    busyId.value = "";
  }
}

function toggleStatus(userId: string, status: UserStatus) { void updateStatus(userId, status === "active" ? "disabled" : "active"); }
function archiveUser(userId: string) { void updateStatus(userId, "archived"); }
</script>

<style scoped>
.user-access-settings { max-width: 1080px; }
.user-access-panel, .user-list { display: grid; gap: 12px; }
.user-access-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.user-access-head > div { display: grid; gap: 4px; }
.user-access-head strong { color: var(--text-strong); font-size: 15px; }
.user-access-head p, .user-access-state { color: var(--text-muted); font-size: 13px; margin: 0; }
.create-user-form { align-items: end; border-block: 1px solid var(--line); display: grid; gap: 12px; grid-template-columns: repeat(4, minmax(130px, 1fr)) auto; padding: 14px 0; }
.create-user-form label, .compact-field { display: grid; gap: 6px; min-width: 0; }
.create-user-form label > span, .compact-field > span { color: var(--text-muted); font-size: 12px; }
.create-user-actions { display: flex; }
.user-row { align-items: center; background: var(--surface-inset); border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 12px; grid-template-columns: minmax(150px, 1fr) 150px minmax(220px, 1.5fr) auto; padding: 12px; }
.user-identity { display: grid; gap: 3px; min-width: 0; }
.user-identity > div { align-items: center; display: flex; gap: 7px; }
.user-identity strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; }
.user-identity code { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.status { border: 1px solid var(--line); border-radius: 999px; color: var(--text-muted); font-size: 12px; padding: 1px 6px; }
.status[data-status="active"] { color: var(--status-success); }
.status[data-status="disabled"], .status[data-status="archived"] { color: var(--status-warning); }
.node-scope { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.node-option { align-items: center; display: flex; font-size: 13px; gap: 7px; min-width: 0; }
.user-actions { display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }
.user-access-error { color: var(--status-danger); font-size: 13px; }
.spinning { animation: user-access-spin .8s linear infinite; }
@keyframes user-access-spin { to { transform: rotate(360deg); } }
@media (max-width: 900px) { .create-user-form, .user-row { grid-template-columns: 1fr; } .user-actions { justify-content: flex-start; } }
</style>
