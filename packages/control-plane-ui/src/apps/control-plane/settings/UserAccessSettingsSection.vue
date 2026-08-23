<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="settings-section-scroll-content user-access-settings">
      <section class="modal-section settings-panel-surface user-access-panel">
        <header class="user-access-head">
          <div><span class="user-access-context">{{ t("settings.userAccess.context") }}</span><strong>{{ t("settings.userAccess.title") }}</strong><p>{{ t("settings.userAccess.description") }}</p></div>
          <Button variant="outline" size="sm" :disabled="refreshing" @click="refresh"><RefreshCw :class="{ spinning: refreshing }" :size="14" />{{ t("common.actions.refresh") }}</Button>
        </header>

        <Tabs v-model="activeView" class="access-tabs">
          <TabsList class="access-tabs-list"><TabsTrigger value="users"><Users :size="14" />{{ t("settings.userAccess.tabs.users") }}</TabsTrigger><TabsTrigger value="roles"><ShieldCheck :size="14" />{{ t("settings.userAccess.tabs.roles") }}</TabsTrigger><TabsTrigger value="providers"><KeyRound :size="14" />{{ t("settings.userAccess.tabs.providers") }}</TabsTrigger></TabsList>
          <TabsContent value="users" class="access-tab-content">
            <div class="user-toolbar"><div class="search-field"><Search :size="14" /><Input v-model="search" :placeholder="t('settings.userAccess.search')" /></div><ControlPlaneSelect v-model="statusFilter"><ControlPlaneSelectItem value="all">{{ t("settings.userAccess.allStatuses") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="active">{{ statusLabel("active") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="disabled">{{ statusLabel("disabled") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="archived">{{ statusLabel("archived") }}</ControlPlaneSelectItem></ControlPlaneSelect><Button size="sm" @click="createOpen = true"><UserPlus :size="14" />{{ t("settings.userAccess.create") }}</Button></div>
            <p v-if="users.isLoading.value || roles.isLoading.value" class="user-access-state">{{ t("settings.userAccess.loading") }}</p>
            <p v-else-if="users.error.value || roles.error.value" class="user-access-error" role="alert">{{ errorText(users.error.value || roles.error.value) }}</p>
            <p v-else-if="!filteredUsers.length" class="user-access-state">{{ t("settings.userAccess.empty") }}</p>
            <div v-else class="user-list">
              <article v-for="user in filteredUsers" :key="user.id" class="user-row">
                <div class="user-identity"><div><strong>{{ user.displayName }}</strong><span class="status" :data-status="user.status">{{ statusLabel(user.status) }}</span></div><code>{{ user.primaryUsername || user.id }}</code></div>
                <span class="user-role-summary">{{ roleSummary(user.id) }}</span>
                <span class="user-scope-summary">{{ scopeSummary(user.id) }}</span>
                <Button variant="outline" size="sm" @click="openUser(user.id)"><Settings2 :size="14" />{{ t("settings.userAccess.manage") }}</Button>
              </article>
            </div>
          </TabsContent>
          <TabsContent value="roles" class="access-tab-content"><RoleManagementPanel :details="details" /></TabsContent>
          <TabsContent value="providers" class="access-tab-content"><IdentityProviderManagementPanel /></TabsContent>
        </Tabs>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="createOpen" @update:open="(open) => !creating && (createOpen = open)"><DialogContent><DialogHeader><DialogTitle>{{ t("settings.userAccess.create") }}</DialogTitle><DialogDescription>{{ t("settings.userAccess.createDescription") }}</DialogDescription></DialogHeader><form class="management-form" @submit.prevent="createUser"><label><span>{{ t("settings.userAccess.displayName") }}</span><Input v-model="createDraft.displayName" autocomplete="name" /></label><label><span>{{ t("settings.userAccess.username") }}</span><Input v-model="createDraft.username" autocomplete="username" /></label><label><span>{{ t("settings.userAccess.password") }}</span><Input v-model="createDraft.password" type="password" autocomplete="new-password" /></label><label><span>{{ t("settings.userAccess.role") }}</span><ControlPlaneSelect v-model="createDraft.roleId"><ControlPlaneSelectItem v-for="role in activeRoles" :key="role.id" :value="role.id">{{ role.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label><DialogFooter><Button type="button" variant="outline" @click="createOpen = false">{{ t("common.actions.cancel") }}</Button><Button type="submit" :disabled="creating || !canCreate">{{ creating ? t("settings.userAccess.creating") : t("settings.userAccess.create") }}</Button></DialogFooter></form></DialogContent></Dialog>

  <Dialog :open="profileOpen" @update:open="closeProfileEditor"><DialogContent class="z-[60] profile-dialog" overlay-class="z-[60]"><DialogHeader><DialogTitle>{{ t("settings.userAccess.profileEdit") }}</DialogTitle><DialogDescription>{{ t("settings.userAccess.profileDescription") }}</DialogDescription></DialogHeader><form class="management-form" @submit.prevent="saveProfile"><label><span>{{ t("settings.userAccess.displayName") }}</span><Input v-model="profileName" autocomplete="name" :disabled="busy" /></label><label v-if="selectedDetail?.primaryUsername"><span>{{ t("settings.userAccess.loginUsername") }}</span><Input v-model="profileUsername" autocomplete="username" :disabled="busy" /></label><DialogFooter><Button type="button" variant="outline" :disabled="busy" @click="closeProfileEditor(false)">{{ t("common.actions.cancel") }}</Button><Button type="submit" :disabled="!canSaveProfile">{{ t("common.actions.save") }}</Button></DialogFooter></form></DialogContent></Dialog>

  <Dialog :open="permissionsOpen" @update:open="(open) => permissionsOpen = open"><DialogContent class="z-[60] permission-dialog" overlay-class="z-[60]"><DialogHeader><DialogTitle>{{ t("settings.userAccess.effectivePermissions") }}</DialogTitle><DialogDescription>{{ t("settings.userAccess.permissionSummary", { permissions: effectivePermissions.length, resources: effectivePermissionGroups.length }) }}</DialogDescription></DialogHeader><ScrollArea class="permission-details-scroll" :horizontal="false"><div class="permission-groups"><section v-for="group in effectivePermissionGroups" :key="group.resource" class="permission-group"><strong>{{ permissionResourceLabel(group.resource) }}</strong><div><span v-for="permission in group.permissions" :key="permission.id">{{ permissionLabel(permission) }}</span></div></section><p v-if="!effectivePermissionGroups.length" class="muted">{{ t("settings.userAccess.noPermissions") }}</p></div></ScrollArea><DialogFooter><Button variant="outline" @click="permissionsOpen = false">{{ t("common.actions.close") }}</Button></DialogFooter></DialogContent></Dialog>

  <Dialog :open="passwordResetOpen" @update:open="closePasswordReset"><DialogContent class="z-[60] password-reset-dialog" overlay-class="z-[60]"><DialogHeader><DialogTitle>{{ t("settings.userAccess.passwordReset.dialogTitle") }}</DialogTitle><DialogDescription>{{ t("settings.userAccess.passwordReset.description") }}</DialogDescription></DialogHeader><div class="password-reset-field"><Input :model-value="newPassword" readonly autocomplete="new-password" /><Button type="button" variant="outline" :disabled="busy" @click="newPassword = generateTemporaryPassword()">{{ t("settings.userAccess.passwordReset.regenerate") }}</Button></div><DialogFooter><Button type="button" variant="outline" :disabled="busy" @click="closePasswordReset(false)">{{ t("common.actions.cancel") }}</Button><Button :disabled="busy || newPassword.length < 8" @click="resetPassword">{{ t("settings.userAccess.passwordReset.confirm") }}</Button></DialogFooter></DialogContent></Dialog>

  <Dialog :open="Boolean(selectedUserId)" @update:open="closeUser"><DialogContent class="user-detail-dialog"><DialogHeader class="user-detail-header"><DialogTitle>{{ selectedDetail?.displayName || t("settings.userAccess.userDetail") }}</DialogTitle><DialogDescription>{{ selectedDetail?.primaryUsername || selectedDetail?.id }}</DialogDescription><button type="button" class="user-detail-close" :aria-label="t('common.actions.close')" :title="t('common.actions.close')" :disabled="busy" @click="closeUser(false)"><X :size="16" /></button></DialogHeader>
    <p v-if="detailLoading || !selectedDetail" class="user-access-state">{{ t("settings.userAccess.loadingAccess") }}</p>
    <Tabs v-else v-model="detailTab" class="detail-tabs">
      <TabsList class="access-tabs-list"><TabsTrigger value="access">{{ t("settings.userAccess.detailTabs.access") }}</TabsTrigger><TabsTrigger value="security">{{ t("settings.userAccess.detailTabs.security") }}</TabsTrigger></TabsList>
      <TabsContent value="access" class="detail-content">
        <section class="detail-section"><div class="section-heading"><strong>{{ t("settings.userAccess.profile") }}</strong><Button variant="outline" size="sm" :disabled="busy" @click="openProfileEditor"><Settings2 :size="14" />{{ t("common.actions.edit") }}</Button></div><div class="profile-summary"><div><span>{{ t("settings.userAccess.displayName") }}</span><strong>{{ selectedDetail.displayName }}</strong></div><div><span>{{ t("settings.userAccess.loginUsername") }}</span><code>{{ selectedDetail.primaryUsername || t("settings.userAccess.externalAccount") }}</code></div></div></section>
        <section class="detail-section"><strong>{{ t("settings.userAccess.roles.title") }}</strong><div class="option-grid"><label v-for="role in activeRoles" :key="role.id" class="check-option"><Checkbox :model-value="accessDraft.roleIds.includes(role.id)" :disabled="busy" @update:model-value="(value) => toggleRole(role.id, value === true)" /><span>{{ role.name }}</span></label></div></section>
        <section class="detail-section"><div class="section-heading"><div class="section-title-with-summary"><strong>{{ t("settings.userAccess.effectivePermissions") }}</strong><span class="muted">{{ t("settings.userAccess.permissionSummary", { permissions: effectivePermissions.length, resources: effectivePermissionGroups.length }) }}</span></div><Button v-if="effectivePermissions.length" variant="outline" size="sm" @click="permissionsOpen = true">{{ t("settings.userAccess.viewPermissionDetails") }}</Button></div></section>
        <section class="detail-section access-scope-section">
          <strong>{{ t("settings.userAccess.accessScope") }}</strong>
          <div class="scope-tree" role="tree">
            <div class="scope-tree-item" role="treeitem" aria-expanded="true">
              <label class="check-option scope-tree-row scope-tree-root">
                <Checkbox :model-value="allNodesCheckboxState" :disabled="busy" @update:model-value="(value) => setAllNodes(value === true)" />
                <span>{{ t("settings.userAccess.allNodes") }}</span>
              </label>
              <div class="scope-tree-children" role="group">
                <label class="check-option scope-tree-row">
                  <Checkbox :model-value="accessDraft.instanceScope.kind === 'inherit-node-scope'" :disabled="busy" @update:model-value="(value) => setInheritNodeInstances(value === true)" />
                  <span>{{ t("settings.userAccess.inheritNodeInstances") }}</span>
                </label>
                <div v-if="showScopeBranches" class="scope-tree-node-list" role="group">
                  <div v-for="branch in scopeTreeNodes" :key="branch.id" class="scope-tree-item" role="treeitem" :aria-expanded="accessDraft.instanceScope.kind === 'selected'">
                    <label class="check-option scope-tree-row">
                      <Checkbox :model-value="nodeIsSelected(branch.id)" :disabled="busy" @update:model-value="(value) => toggleNode(branch.id, value === true)" />
                      <span>{{ branch.name }}</span>
                    </label>
                    <div v-if="accessDraft.instanceScope.kind === 'selected' && branch.instances.length" class="scope-tree-children" role="group">
                      <label v-for="instance in branch.instances" :key="instance.id" class="check-option scope-tree-row scope-tree-leaf" role="treeitem">
                        <Checkbox :model-value="accessDraft.instanceScope.instanceIds.includes(instance.id)" :disabled="busy" @update:model-value="(value) => toggleInstance(instance.id, value === true)" />
                        <span>{{ instance.name }}</span>
                      </label>
                    </div>
                  </div>
                  <span v-if="accessDraft.instanceScope.kind === 'selected' && !instances.length" class="muted scope-tree-empty">{{ t("settings.userAccess.noInstances") }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
        <div class="detail-actions"><Button :disabled="busy || !accessDraft.roleIds.length" @click="saveAccess">{{ t("settings.userAccess.saveAccess") }}</Button><Button v-if="selectedDetail.status !== 'archived'" variant="outline" :disabled="busy" @click="confirmAction = selectedDetail.status === 'active' ? 'disable' : 'enable'">{{ selectedDetail.status === "active" ? t("settings.userAccess.disable") : t("settings.userAccess.enable") }}</Button><Button variant="outline" :disabled="busy" @click="confirmAction = selectedDetail.status === 'archived' ? 'restore' : 'archive'">{{ selectedDetail.status === "archived" ? t("settings.userAccess.restore") : t("settings.userAccess.archive") }}</Button></div>
      </TabsContent>
      <TabsContent value="security" class="detail-content">
        <section class="detail-section"><strong>{{ t("settings.userAccess.identities.title") }}</strong><div class="identity-list"><div v-for="identity in selectedDetail.identities" :key="identity.id" class="identity-row"><div><span>{{ identity.kind }}</span><code>{{ identity.loginName || identity.verifiedEmail || identity.subject }}</code></div><Button v-if="identity.kind !== 'local-password'" variant="outline" size="icon" :aria-label="t('settings.userAccess.identities.unbind')" @click="unbindTargetId = identity.id"><Unlink :size="14" /></Button></div></div></section>
        <section v-if="selectedDetail.identities.some((identity) => identity.kind === 'local-password')" class="detail-section"><div class="section-heading"><div class="section-title-with-summary"><strong>{{ t("settings.userAccess.passwordReset.title") }}</strong><span class="muted">{{ t("settings.userAccess.passwordReset.summary") }}</span></div><Button variant="outline" size="sm" :disabled="busy" @click="openPasswordReset">{{ t("settings.userAccess.passwordReset.action") }}</Button></div></section>
        <section class="detail-section"><div class="section-heading"><strong>{{ t("settings.userAccess.sessions.title") }}</strong><Button v-if="sessions.length" variant="outline" size="sm" :disabled="busy" @click="confirmAction = 'revoke-all'">{{ t("settings.userAccess.sessions.revokeAll") }}</Button></div><p v-if="sessionsLoading" class="muted">{{ t("settings.userAccess.loading") }}</p><div v-else class="session-list"><div v-for="session in sessions" :key="session.id" class="session-row"><div><span>{{ session.clientType }}</span><code>{{ formatDate(session.lastSeenAt || session.createdAt) }}</code></div><Button variant="outline" size="sm" :disabled="busy" @click="revokeSessionTarget = session.id">{{ t("settings.userAccess.sessions.revoke") }}</Button></div><p v-if="!sessions.length" class="muted">{{ t("settings.userAccess.sessions.empty") }}</p></div></section>
      </TabsContent>
    </Tabs>
  </DialogContent></Dialog>

  <AlertDialog :open="Boolean(confirmAction || unbindTargetId || revokeSessionTarget)" @update:open="clearConfirmation"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ confirmationTitle }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.userAccess.confirmDescription") }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction :disabled="busy" @click="executeConfirmation">{{ t("common.actions.confirm") }}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { KeyRound, RefreshCw, Search, Settings2, ShieldCheck, Unlink, UserPlus, Users, X } from "@lucide/vue";
import type { ControlPlanePermissionDescriptor, ControlPlaneUserDetail, ControlPlaneUserSessionSummary } from "@task-handoff/protocol/control-plane-access";
import type { InstanceBoardItem, Node } from "../../../api/types";
import { createControlPlaneUser, getControlPlaneUserDetail, listControlPlaneUserSessions, resetControlPlaneUserPassword, revokeAllControlPlaneUserSessions, revokeControlPlaneUserSession, setControlPlaneUserAccess, unbindControlPlaneUserExternalIdentity, updateControlPlaneUser, useIdentityProvidersQuery, usePermissionsQuery, useRolesQuery, useUsersQuery } from "../../../api/queries";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { translateApiError } from "../../../i18n/apiError";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import IdentityProviderManagementPanel from "./IdentityProviderManagementPanel.vue";
import RoleManagementPanel from "./RoleManagementPanel.vue";
import { generateTemporaryPassword } from "./temporaryPassword";

const props = defineProps<{ nodes: Node[]; instances: InstanceBoardItem[] }>();
const { t, te, locale } = useI18n();
const users = useUsersQuery(true, true), roles = useRolesQuery(), permissions = usePermissionsQuery(), providers = useIdentityProvidersQuery();
const details = reactive<Record<string, ControlPlaneUserDetail>>({});
const activeView = ref("users"), detailTab = ref("access"), search = ref(""), statusFilter = ref("all");
const loadingDetails = ref(false), detailLoading = ref(false), creating = ref(false), busy = ref(false), createOpen = ref(false), profileOpen = ref(false), permissionsOpen = ref(false), passwordResetOpen = ref(false), selectedUserId = ref("");
const confirmAction = ref<"enable" | "disable" | "archive" | "restore" | "revoke-all" | "">("");
const unbindTargetId = ref(""), revokeSessionTarget = ref(""), profileName = ref(""), profileUsername = ref(""), newPassword = ref("");
const sessions = ref<ControlPlaneUserSessionSummary[]>([]), sessionsLoading = ref(false);
const createDraft = reactive({ displayName: "", username: "", password: "", roleId: "role_operator" });
const accessDraft = reactive<Pick<ControlPlaneUserDetail["accessGrant"], "roleIds" | "nodeScope" | "instanceScope">>({ roleIds: [], nodeScope: { kind: "all" }, instanceScope: { kind: "inherit-node-scope" } });
const activeRoles = computed(() => (roles.data.value || []).filter((role) => role.status === "active"));
const selectedDetail = computed(() => details[selectedUserId.value]);
const canCreate = computed(() => createDraft.displayName.trim() && createDraft.username.trim() && createDraft.password.length >= 8 && createDraft.roleId);
const refreshing = computed(() => users.isFetching.value || roles.isFetching.value || providers.isFetching.value || loadingDetails.value);
const filteredUsers = computed(() => { const term = search.value.trim().toLocaleLowerCase(); return (users.data.value || []).filter((user) => (statusFilter.value === "all" || user.status === statusFilter.value) && (!term || user.displayName.toLocaleLowerCase().includes(term) || user.primaryUsername?.toLocaleLowerCase().includes(term))); });
const effectivePermissions = computed(() => { const ids = new Set(activeRoles.value.filter((role) => accessDraft.roleIds.includes(role.id)).flatMap((role) => role.permissionIds)); return (permissions.data.value || []).filter((permission) => ids.has(permission.id)); });
const effectivePermissionGroups = computed(() => {
  const groups = new Map<string, ControlPlanePermissionDescriptor[]>();
  for (const permission of effectivePermissions.value) groups.set(permission.resource, [...(groups.get(permission.resource) || []), permission]);
  return [...groups].map(([resource, groupedPermissions]) => ({ resource, permissions: groupedPermissions }));
});
const canSaveProfile = computed(() => Boolean(!busy.value && profileName.value.trim() && (!selectedDetail.value?.primaryUsername || profileUsername.value.trim())));
const allNodesCheckboxState = computed(() => accessDraft.nodeScope.kind === "all" ? true : accessDraft.nodeScope.nodeIds.length ? "indeterminate" : false);
const showScopeBranches = computed(() => accessDraft.nodeScope.kind === "selected" || accessDraft.instanceScope.kind === "selected");
const scopeTreeNodes = computed(() => {
  const branches = new Map(props.nodes.map((node) => [node.id, { id: node.id, name: node.name, instances: [] as InstanceBoardItem[] }]));
  for (const instance of props.instances) {
    const branch = branches.get(instance.nodeId) || { id: instance.nodeId, name: instance.node?.name || instance.nodeId, instances: [] as InstanceBoardItem[] };
    branch.instances.push(instance);
    branches.set(instance.nodeId, branch);
  }
  return [...branches.values()];
});
type UserStatus = ControlPlaneUserDetail["status"];
const errorText = (error: unknown) => translateApiError(error, t, t("settings.userAccess.failed"));
const statusLabel = (status: UserStatus) => t(`settings.userAccess.status.${status}`);
const permissionLabel = (permission: ControlPlanePermissionDescriptor) => permission.translationKey && te(permission.translationKey) ? t(permission.translationKey) : permission.name;
const permissionResourceLabel = (resource: string) => te(`settings.userAccess.permissionResources.${resource}`) ? t(`settings.userAccess.permissionResources.${resource}`) : resource;
const roleSummary = (userId: string) => details[userId]?.accessGrant.roleIds.map((id) => roles.data.value?.find((role) => role.id === id)?.name || id).join(", ") || t("settings.userAccess.loadingAccess");
const scopeSummary = (userId: string) => { const grant = details[userId]?.accessGrant; if (!grant) return ""; const nodes = grant.nodeScope.kind === "all" ? t("settings.userAccess.allNodes") : t("settings.userAccess.selectedNodes", { count: grant.nodeScope.nodeIds.length }); const instances = grant.instanceScope.kind === "inherit-node-scope" ? t("settings.userAccess.inheritNodeInstances") : t("settings.userAccess.selectedInstances", { count: grant.instanceScope.instanceIds.length }); return `${nodes} · ${instances}`; };
const confirmationTitle = computed(() => unbindTargetId.value ? t("settings.userAccess.identities.unbindTitle") : revokeSessionTarget.value ? t("settings.userAccess.sessions.revokeTitle") : t(`settings.userAccess.confirm.${confirmAction.value || "archive"}`));
const formatDate = (value: string) => new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

async function loadDetails() { loadingDetails.value = true; try { const current = users.data.value || []; const loaded = await Promise.all(current.map((user) => getControlPlaneUserDetail(user.id))); for (const detail of loaded) details[detail.id] = detail; for (const id of Object.keys(details)) if (!current.some((user) => user.id === id)) delete details[id]; } catch (error) { showControlPlaneToast(errorText(error)); } finally { loadingDetails.value = false; } }
watch(() => users.data.value?.map((user) => `${user.id}:${user.updatedAt}`).join("|"), () => void loadDetails(), { immediate: true });
async function refresh() { await Promise.all([users.refetch(), roles.refetch(), providers.refetch()]); await loadDetails(); }
async function createUser() { if (!canCreate.value) return; creating.value = true; try { await createControlPlaneUser({ username: createDraft.username.trim(), password: createDraft.password, displayName: createDraft.displayName.trim(), roleIds: [createDraft.roleId], nodeScope: { kind: "all" }, instanceScope: { kind: "inherit-node-scope" }, requirePasswordChange: true }); Object.assign(createDraft, { displayName: "", username: "", password: "", roleId: activeRoles.value[0]?.id || "" }); createOpen.value = false; await refresh(); showControlPlaneToast(t("settings.userAccess.created"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); } finally { creating.value = false; } }
async function openUser(userId: string) { selectedUserId.value = userId; detailTab.value = "access"; detailLoading.value = true; try { const detail = await getControlPlaneUserDetail(userId); details[userId] = detail; resetDetailDraft(detail); await loadSessions(userId); } catch (error) { showControlPlaneToast(errorText(error)); selectedUserId.value = ""; } finally { detailLoading.value = false; } }
function closeUser(open: boolean) { if (!open && !busy.value) { selectedUserId.value = ""; sessions.value = []; profileOpen.value = false; permissionsOpen.value = false; passwordResetOpen.value = false; } }
function resetDetailDraft(detail: ControlPlaneUserDetail) { profileName.value = detail.displayName; profileUsername.value = detail.primaryUsername || ""; Object.assign(accessDraft, { roleIds: [...detail.accessGrant.roleIds], nodeScope: detail.accessGrant.nodeScope.kind === "all" ? { kind: "all" } : { kind: "selected", nodeIds: [...detail.accessGrant.nodeScope.nodeIds] }, instanceScope: detail.accessGrant.instanceScope.kind === "inherit-node-scope" ? { kind: "inherit-node-scope" } : { kind: "selected", instanceIds: [...detail.accessGrant.instanceScope.instanceIds] } }); }
async function loadSessions(userId: string) { sessionsLoading.value = true; try { sessions.value = await listControlPlaneUserSessions(userId); } catch (error) { showControlPlaneToast(errorText(error)); } finally { sessionsLoading.value = false; } }
async function reloadSelected() { if (!selectedUserId.value) return; const detail = await getControlPlaneUserDetail(selectedUserId.value); details[detail.id] = detail; resetDetailDraft(detail); await users.refetch(); }
function openProfileEditor() { const detail = selectedDetail.value; if (!detail) return; profileName.value = detail.displayName; profileUsername.value = detail.primaryUsername || ""; profileOpen.value = true; }
function closeProfileEditor(open: boolean) { if (!busy.value) profileOpen.value = open; }
async function saveProfile() { const detail = selectedDetail.value; if (!detail || !canSaveProfile.value) return; busy.value = true; try { details[detail.id] = await updateControlPlaneUser(detail.id, { displayName: profileName.value.trim(), ...(detail.primaryUsername ? { username: profileUsername.value.trim() } : {}) }); await users.refetch(); resetDetailDraft(details[detail.id]); profileOpen.value = false; showControlPlaneToast(t("settings.userAccess.profileSaved"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); } finally { busy.value = false; } }
function openPasswordReset() { newPassword.value = generateTemporaryPassword(); passwordResetOpen.value = true; }
function closePasswordReset(open: boolean) { if (!busy.value) { passwordResetOpen.value = open; if (!open) newPassword.value = ""; } }
async function resetPassword() { const detail = selectedDetail.value; if (!detail || newPassword.value.length < 8) return; busy.value = true; try { await resetControlPlaneUserPassword(detail.id, { password: newPassword.value, requirePasswordChange: true }); passwordResetOpen.value = false; newPassword.value = ""; await Promise.all([reloadSelected(), loadSessions(detail.id)]); showControlPlaneToast(t("settings.userAccess.passwordReset.saved"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); } finally { busy.value = false; } }
async function saveAccess() { const detail = selectedDetail.value; if (!detail) return; busy.value = true; try { details[detail.id] = await setControlPlaneUserAccess(detail.id, { roleIds: accessDraft.roleIds, nodeScope: accessDraft.nodeScope, instanceScope: accessDraft.instanceScope, expectedAuthorizationRevision: detail.accessGrant.authorizationRevision }); resetDetailDraft(details[detail.id]); await users.refetch(); showControlPlaneToast(t("settings.userAccess.saved"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); await reloadSelected(); } finally { busy.value = false; } }
function toggleRole(id: string, checked: boolean) { accessDraft.roleIds = checked ? [...new Set([...accessDraft.roleIds, id])] : accessDraft.roleIds.filter((value) => value !== id); }
function setAllNodes(checked: boolean) { accessDraft.nodeScope = checked ? { kind: "all" } : { kind: "selected", nodeIds: [] }; }
function nodeIsSelected(id: string) { return accessDraft.nodeScope.kind === "all" || accessDraft.nodeScope.nodeIds.includes(id); }
function toggleNode(id: string, checked: boolean) {
  if (accessDraft.nodeScope.kind === "all") {
    if (!checked) accessDraft.nodeScope = { kind: "selected", nodeIds: props.nodes.map((node) => node.id).filter((nodeId) => nodeId !== id) };
    return;
  }
  accessDraft.nodeScope.nodeIds = checked ? [...new Set([...accessDraft.nodeScope.nodeIds, id])] : accessDraft.nodeScope.nodeIds.filter((value) => value !== id);
}
function setInheritNodeInstances(checked: boolean) { accessDraft.instanceScope = checked ? { kind: "inherit-node-scope" } : { kind: "selected", instanceIds: [] }; }
function toggleInstance(id: string, checked: boolean) { if (accessDraft.instanceScope.kind !== "selected") return; accessDraft.instanceScope.instanceIds = checked ? [...new Set([...accessDraft.instanceScope.instanceIds, id])] : accessDraft.instanceScope.instanceIds.filter((value) => value !== id); }
function clearConfirmation(open: boolean) { if (!open && !busy.value) { confirmAction.value = ""; unbindTargetId.value = ""; revokeSessionTarget.value = ""; } }
async function executeConfirmation() { const detail = selectedDetail.value; if (!detail) return; busy.value = true; try { if (unbindTargetId.value) await unbindControlPlaneUserExternalIdentity(detail.id, unbindTargetId.value); else if (revokeSessionTarget.value) await revokeControlPlaneUserSession(detail.id, revokeSessionTarget.value); else if (confirmAction.value === "revoke-all") await revokeAllControlPlaneUserSessions(detail.id); else { const status = confirmAction.value === "enable" || confirmAction.value === "restore" ? "active" : confirmAction.value === "disable" ? "disabled" : "archived"; details[detail.id] = await updateControlPlaneUser(detail.id, { status }); } clearConfirmation(false); await Promise.all([reloadSelected(), loadSessions(detail.id)]); showControlPlaneToast(t("settings.userAccess.saved"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); } finally { busy.value = false; confirmAction.value = ""; unbindTargetId.value = ""; revokeSessionTarget.value = ""; } }
</script>

<style scoped>
.user-access-settings{max-width:1080px}.user-access-panel,.user-list,.management-form,.detail-content,.detail-section,.identity-list,.session-list{display:grid;gap:12px}.user-access-head,.user-toolbar,.user-row,.user-identity>div,.detail-actions,.inline-form,.bind-form,.identity-row,.session-row,.section-heading,.check-option{align-items:center;display:flex;gap:10px}.user-access-head{align-items:flex-start;justify-content:space-between}.user-access-head>div{display:grid;gap:4px}.user-access-context,.user-access-head p,.user-access-state,.user-role-summary,.user-scope-summary,.muted{color:var(--text-muted);font-size:12px;margin:0}.user-access-head strong{font-size:15px}.access-tabs{display:grid;gap:14px}.access-tabs-list{align-self:start;background:var(--surface-inset);border:1px solid var(--line);border-radius:7px;gap:1px;height:32px;justify-self:start;min-height:32px;padding:2px;width:fit-content}.access-tabs-list :deep(button){border-radius:5px;color:var(--text-muted);font-size:12px;font-weight:500;height:26px;min-height:26px;padding:0 10px}.access-tabs-list :deep(.truncate){align-items:center;display:inline-flex;gap:6px;min-width:0}.access-tabs-list :deep(.truncate svg){flex:0 0 auto}.access-tabs-list :deep(button:not([data-state="active"]):hover){background:var(--surface-hover);color:var(--text-strong)}.access-tabs-list :deep(button[data-state="active"]){background:var(--surface-active);color:var(--text-strong);box-shadow:none}.access-tab-content{margin:0}.user-toolbar{border-bottom:1px solid var(--line);padding-bottom:12px}.search-field{align-items:center;display:flex;flex:1;min-width:180px;position:relative}.search-field>svg{color:var(--text-muted);left:10px;position:absolute}.search-field :deep(input){padding-left:32px}.user-row{border-bottom:1px solid var(--line);padding:12px 0}.user-identity{display:grid;flex:1;gap:3px;min-width:150px}.user-identity strong{font-size:14px}.user-identity code,.identity-row code,.session-row code{color:var(--text-muted);font-size:12px}.status{border:1px solid var(--line);border-radius:999px;color:var(--text-muted);font-size:12px;padding:1px 6px}.status[data-status="active"]{color:var(--status-success)}.status[data-status="disabled"],.status[data-status="archived"]{color:var(--status-warning)}.user-role-summary{min-width:120px}.user-scope-summary{flex:1}.management-form label{display:grid;gap:6px;font-size:12px}.user-detail-dialog{max-height:min(90vh,860px);max-width:820px;overflow:auto}.detail-tabs{display:grid;gap:12px}.detail-section{border-top:1px solid var(--line);padding-top:12px}.detail-section>strong,.section-heading strong{font-size:13px}.section-heading{justify-content:space-between}.option-grid{display:grid;gap:8px;grid-template-columns:repeat(3,minmax(0,1fr))}.check-option{font-size:12px;min-width:0}.access-scope-section{gap:10px}.scope-tree{padding-left:2px}.scope-tree-row{min-height:26px;position:relative}.scope-tree-root{font-weight:500}.scope-tree-children{display:grid;gap:2px;margin-left:7px;padding-left:22px;position:relative}.scope-tree-children::before{background:var(--line);content:"";inset:0 auto 13px 0;position:absolute;width:1px}.scope-tree-children>.scope-tree-row::before,.scope-tree-children>.scope-tree-node-list>.scope-tree-item>.scope-tree-row::before{background:var(--line);content:"";height:1px;left:-22px;position:absolute;top:13px;width:14px}.scope-tree-node-list{display:grid;gap:2px}.scope-tree-empty{padding:5px 0}.scope-tree-leaf{color:var(--text-muted)}.permission-preview{display:flex;flex-wrap:wrap;gap:6px}.permission-preview>span:not(.muted){background:var(--surface-inset);border:1px solid var(--line);border-radius:4px;font-family:var(--font-mono);font-size:12px;padding:3px 6px}.detail-actions{border-top:1px solid var(--line);padding-top:12px}.inline-form>*:first-child,.bind-form>*:nth-child(2){flex:1}.identity-row,.session-row{justify-content:space-between}.identity-row>div,.session-row>div{display:grid;gap:2px}.bind-form{align-items:end}.user-access-error{color:var(--status-danger);font-size:13px}.spinning{animation:user-access-spin .8s linear infinite}@keyframes user-access-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.user-toolbar,.user-row,.bind-form{align-items:stretch;flex-direction:column}.user-row>button{align-self:flex-start}.option-grid{grid-template-columns:1fr}.user-role-summary,.user-scope-summary{min-width:0}}
.user-detail-header{padding-right:38px;position:relative}
.user-detail-close{align-items:center;background:var(--surface-hover);border:0;border-radius:6px;color:var(--text-muted);cursor:pointer;display:flex;height:30px;justify-content:center;position:absolute;right:0;top:0;width:30px}
.user-detail-close:hover,.user-detail-close:focus-visible{background:var(--surface-active);color:var(--text-strong);outline:none}
.user-detail-close:disabled{cursor:not-allowed;opacity:.5}
.profile-dialog{max-width:520px}
.password-reset-dialog{max-width:560px}
.password-reset-field{align-items:center;display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto}
.password-reset-field :deep(input){font-family:var(--font-mono)}
.profile-summary{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}
.profile-summary>div{display:grid;gap:4px;min-width:0}
.profile-summary span{color:var(--text-muted);font-size:12px}
.profile-summary strong,.profile-summary code{font-size:13px;font-weight:400;overflow-wrap:anywhere}
.section-title-with-summary{display:grid;gap:3px}
.permission-dialog{max-width:700px}
.permission-details-scroll{height:min(60vh,520px)}
.permission-groups{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr));padding-right:10px}
.permission-group{background:var(--surface-inset);border:1px solid var(--line);border-radius:7px;display:grid;gap:8px;padding:10px}
.permission-group>strong{font-size:12px;font-weight:500}
.permission-group>div{display:flex;flex-wrap:wrap;gap:6px}
.permission-group span{background:var(--surface-hover);border-radius:4px;color:var(--text-muted);font-size:12px;padding:3px 6px}
@media(max-width:760px){.profile-summary,.permission-groups{grid-template-columns:1fr}}
</style>
