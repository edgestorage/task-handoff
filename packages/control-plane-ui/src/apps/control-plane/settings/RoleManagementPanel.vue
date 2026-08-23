<template>
  <div class="access-management-view">
    <div class="management-toolbar">
      <div><strong>{{ t("settings.userAccess.roles.title") }}</strong><p>{{ t("settings.userAccess.roles.description") }}</p></div>
      <Button size="sm" @click="openCreate"><Plus :size="14" />{{ t("settings.userAccess.roles.create") }}</Button>
    </div>
    <p v-if="roles.isLoading.value || permissions.isLoading.value" class="management-state">{{ t("settings.userAccess.loading") }}</p>
    <p v-else-if="roles.error.value || permissions.error.value" class="management-error">{{ errorText(roles.error.value || permissions.error.value) }}</p>
    <div v-else class="management-list">
      <article v-for="role in roles.data.value" :key="role.id" class="management-row">
        <div class="management-primary"><div><strong>{{ role.name }}</strong><span v-if="role.system" class="management-badge">{{ t("settings.userAccess.roles.system") }}</span><span v-if="role.status === 'archived'" class="management-badge">{{ t("settings.userAccess.status.archived") }}</span></div><p>{{ role.description || t("settings.userAccess.roles.noDescription") }}</p></div>
        <span class="management-meta">{{ t("settings.userAccess.roles.permissionCount", { count: role.permissionIds.length }) }} · {{ t("settings.userAccess.roles.userCount", { count: referenceCount(role.id) }) }}</span>
        <div class="management-actions">
          <Button variant="outline" size="sm" :disabled="role.system || role.status === 'archived'" @click="openEdit(role)"><Pencil :size="14" />{{ t("common.actions.edit") }}</Button>
          <Button v-if="!role.system && role.status !== 'archived'" variant="outline" size="sm" @click="archiveTarget = role"><Archive :size="14" />{{ t("settings.userAccess.archive") }}</Button>
        </div>
      </article>
    </div>

    <Dialog :open="formOpen" @update:open="setFormOpen">
      <DialogContent class="role-dialog">
        <DialogHeader><DialogTitle>{{ editingId ? t("settings.userAccess.roles.edit") : t("settings.userAccess.roles.create") }}</DialogTitle><DialogDescription>{{ t("settings.userAccess.roles.formDescription") }}</DialogDescription></DialogHeader>
        <form class="management-form" @submit.prevent="save">
          <label><span>{{ t("settings.userAccess.roles.name") }}</span><Input v-model="draft.name" /></label>
          <label><span>{{ t("settings.userAccess.roles.roleDescription") }}</span><Input v-model="draft.description" /></label>
          <div class="permission-groups">
            <section v-for="group in permissionGroups" :key="group.resource" class="permission-group">
              <strong>{{ permissionResourceLabel(group.resource) }}</strong>
              <label v-for="permission in group.items" :key="permission.id" class="check-option"><Checkbox :model-value="draft.permissionIds.includes(permission.id)" @update:model-value="(value) => togglePermission(permission.id, value === true)" /><span>{{ permissionLabel(permission) }}</span></label>
            </section>
          </div>
          <DialogFooter><Button type="button" variant="outline" @click="formOpen = false">{{ t("common.actions.cancel") }}</Button><Button type="submit" :disabled="saving || !draft.name.trim() || !draft.permissionIds.length">{{ t("common.actions.save") }}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="Boolean(archiveTarget)" @update:open="(open) => !open && (archiveTarget = undefined)">
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ t("settings.userAccess.roles.archiveTitle", { name: archiveTarget?.name || '' }) }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.userAccess.roles.archiveDescription", { count: archiveTarget ? referenceCount(archiveTarget.id) : 0 }) }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction :disabled="saving" @click="confirmArchive">{{ t("settings.userAccess.archive") }}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Archive, Pencil, Plus } from "@lucide/vue";
import type { ControlPlanePermissionDescriptor, ControlPlanePermissionId, ControlPlaneRoleSummary, ControlPlaneUserDetail } from "@task-handoff/protocol/control-plane-access";
import { archiveControlPlaneRole, createControlPlaneRole, updateControlPlaneRole, usePermissionsQuery, useRolesQuery } from "../../../api/queries";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ details: Record<string, ControlPlaneUserDetail> }>();
const { t, te } = useI18n();
const roles = useRolesQuery();
const permissions = usePermissionsQuery();
const formOpen = ref(false);
const editingId = ref("");
const saving = ref(false);
const archiveTarget = ref<ControlPlaneRoleSummary>();
const draft = reactive<{ name: string; description: string; permissionIds: ControlPlanePermissionId[] }>({ name: "", description: "", permissionIds: [] });
const permissionGroups = computed(() => {
  const groups = new Map<string, NonNullable<typeof permissions.data.value>>();
  for (const permission of permissions.data.value || []) groups.set(permission.resource, [...(groups.get(permission.resource) || []), permission]);
  return [...groups].map(([resource, items]) => ({ resource, items }));
});
const errorText = (error: unknown) => translateApiError(error, t, t("settings.userAccess.failed"));
const permissionLabel = (permission: ControlPlanePermissionDescriptor) => permission.translationKey && te(permission.translationKey) ? t(permission.translationKey) : permission.name;
const permissionResourceLabel = (resource: string) => { const key = `settings.userAccess.permissionResources.${resource}`; return te(key) ? t(key) : resource; };
const referenceCount = (roleId: string) => Object.values(props.details).filter((detail) => detail.accessGrant.roleIds.includes(roleId)).length;
function openCreate() { editingId.value = ""; Object.assign(draft, { name: "", description: "", permissionIds: [] }); formOpen.value = true; }
function openEdit(role: ControlPlaneRoleSummary) { editingId.value = role.id; Object.assign(draft, { name: role.name, description: role.description || "", permissionIds: [...role.permissionIds] }); formOpen.value = true; }
function setFormOpen(open: boolean) { if (!saving.value) formOpen.value = open; }
function togglePermission(id: ControlPlanePermissionId, checked: boolean) { draft.permissionIds = checked ? [...new Set([...draft.permissionIds, id])] : draft.permissionIds.filter((value) => value !== id); }
async function save() {
  saving.value = true;
  try {
    const input = { name: draft.name.trim(), description: draft.description.trim() || undefined, permissionIds: draft.permissionIds };
    if (editingId.value) await updateControlPlaneRole(editingId.value, input); else await createControlPlaneRole(input);
    formOpen.value = false;
    await roles.refetch();
    showControlPlaneToast(t("settings.userAccess.roles.saved"), "success");
  } catch (error) { showControlPlaneToast(errorText(error)); } finally { saving.value = false; }
}
async function confirmArchive() {
  if (!archiveTarget.value) return;
  saving.value = true;
  try { await archiveControlPlaneRole(archiveTarget.value.id); archiveTarget.value = undefined; await roles.refetch(); showControlPlaneToast(t("settings.userAccess.roles.archived"), "success"); }
  catch (error) { showControlPlaneToast(errorText(error)); } finally { saving.value = false; }
}
</script>

<style scoped>
.access-management-view,.management-list,.management-primary,.management-form,.permission-groups,.permission-group{display:grid;gap:12px}.management-toolbar,.management-row,.management-actions,.management-primary>div,.check-option{align-items:center;display:flex;gap:10px}.management-toolbar{justify-content:space-between}.management-toolbar>div{display:grid;gap:3px}.management-toolbar strong,.management-primary strong{font-size:14px}.management-toolbar p,.management-primary p,.management-state,.management-meta{color:var(--text-muted);font-size:12px;margin:0}.management-row{border-bottom:1px solid var(--line);padding:12px 0}.management-primary{flex:1;min-width:0}.management-badge{border:1px solid var(--line);border-radius:999px;color:var(--text-muted);font-size:12px;padding:1px 6px}.management-actions{margin-left:auto}.management-form label{display:grid;gap:6px;font-size:12px}.permission-groups{grid-template-columns:repeat(2,minmax(0,1fr));max-height:min(48vh,460px);overflow:auto}.permission-group{align-content:start;border-top:1px solid var(--line);padding-top:10px}.permission-group strong{font-size:12px;text-transform:capitalize}.check-option{font-size:12px!important}.management-error{color:var(--status-danger);font-size:13px}.role-dialog{max-width:720px}@media(max-width:720px){.management-row{align-items:flex-start;flex-direction:column}.management-actions{margin-left:0}.permission-groups{grid-template-columns:1fr}}
</style>
