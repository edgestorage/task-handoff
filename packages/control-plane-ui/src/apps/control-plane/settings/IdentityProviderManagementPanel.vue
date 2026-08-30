<template>
  <div class="provider-management">
    <div class="management-toolbar">
      <div><strong>{{ t("settings.userAccess.providers.title") }}</strong><p>{{ t("settings.userAccess.providers.description") }}</p></div>
      <Button size="sm" @click="openCreate"><Plus :size="14" />{{ t("settings.userAccess.providers.create") }}</Button>
    </div>
    <p v-if="providers.isLoading.value" class="management-state">{{ t("settings.userAccess.loading") }}</p>
    <p v-else-if="providers.error.value" class="management-error">{{ errorText(providers.error.value) }}</p>
    <div v-else class="management-list">
      <article v-for="provider in providers.data.value" :key="provider.id" class="management-row">
        <div class="management-primary"><div><strong>{{ provider.name }}</strong><span class="management-badge">{{ provider.kind.toUpperCase() }}</span><span class="management-badge" :data-status="provider.status">{{ provider.status }}</span></div><p>{{ provider.issuer || t("settings.userAccess.providers.githubIssuer") }} · {{ provider.callbackUrl }}</p></div>
        <span class="management-meta">{{ provider.loginPolicy }} · {{ provider.clientSecretConfigured ? t("settings.userAccess.providers.secretConfigured") : t("settings.userAccess.providers.secretMissing") }}</span>
        <div class="management-actions"><Button variant="outline" size="sm" @click="openEdit(provider)"><Pencil :size="14" />{{ t("common.actions.edit") }}</Button><Button variant="outline" size="sm" @click="toggleProvider(provider)"><Power :size="14" />{{ provider.status === "enabled" ? t("settings.userAccess.disable") : t("settings.userAccess.enable") }}</Button><Button variant="outline" size="icon" :aria-label="t('common.actions.delete')" @click="removeTarget = provider"><Trash2 :size="14" /></Button></div>
      </article>
      <p v-if="!providers.data.value?.length" class="management-state">{{ t("settings.userAccess.providers.empty") }}</p>
    </div>

    <section class="approval-section">
      <div><strong>{{ t("settings.userAccess.approvals.title") }}</strong><p>{{ t("settings.userAccess.approvals.description") }}</p></div>
      <p v-if="approvals.isLoading.value" class="management-state">{{ t("settings.userAccess.loading") }}</p>
      <div v-else class="management-list">
        <article v-for="approval in pendingApprovals" :key="approval.id" class="management-row">
          <div class="management-primary"><strong>{{ approval.displayName || approval.verifiedEmail || approval.subject }}</strong><p>{{ providerName(approval.providerId) }} · {{ approval.verifiedEmail || approval.subject }}</p></div>
          <div class="management-actions"><Button size="sm" @click="openApproval(approval)"><UserCheck :size="14" />{{ t("settings.userAccess.approvals.approve") }}</Button><Button variant="outline" size="sm" @click="rejectTarget = approval"><UserX :size="14" />{{ t("settings.userAccess.approvals.reject") }}</Button></div>
        </article>
        <p v-if="!pendingApprovals.length" class="management-state">{{ t("settings.userAccess.approvals.empty") }}</p>
      </div>
    </section>

    <Dialog :open="formOpen" @update:open="(open) => !saving && (formOpen = open)"><DialogContent class="provider-dialog"><DialogHeader><DialogTitle>{{ editingId ? t("settings.userAccess.providers.edit") : t("settings.userAccess.providers.create") }}</DialogTitle><DialogDescription>{{ t("settings.userAccess.providers.formDescription") }}</DialogDescription></DialogHeader><form class="provider-form" @submit.prevent="saveProvider">
      <label><span>{{ t("settings.userAccess.providers.name") }}</span><Input v-model="draft.name" /></label>
      <label><span>{{ t("settings.userAccess.providers.kind") }}</span><ControlPlaneSelect v-model="draft.kind" :disabled="Boolean(editingId)"><ControlPlaneSelectItem value="oidc">OIDC</ControlPlaneSelectItem><ControlPlaneSelectItem value="github">GitHub</ControlPlaneSelectItem></ControlPlaneSelect></label>
      <label v-if="draft.kind === 'oidc'" class="wide"><span>{{ t("settings.userAccess.providers.issuer") }}</span><Input v-model="draft.issuer" type="url" /></label>
      <label><span>{{ t("settings.userAccess.providers.clientId") }}</span><Input v-model="draft.clientId" /></label>
      <label><span>{{ t("settings.userAccess.providers.clientSecret") }}</span><Input v-model="draft.clientSecret" type="password" :placeholder="editingId ? t('settings.userAccess.providers.keepSecret') : ''" /></label>
      <label class="wide"><span>{{ t("settings.userAccess.providers.callbackUrl") }}</span><Input v-model="draft.callbackUrl" type="url" /></label>
      <label><span>{{ t("settings.userAccess.providers.loginPolicy") }}</span><ControlPlaneSelect v-model="draft.loginPolicy"><ControlPlaneSelectItem value="existing-only">existing-only</ControlPlaneSelectItem><ControlPlaneSelectItem value="admin-approved-create">admin-approved-create</ControlPlaneSelectItem></ControlPlaneSelect></label>
      <label><span>{{ t("settings.userAccess.providers.status") }}</span><ControlPlaneSelect v-model="draft.status"><ControlPlaneSelectItem value="disabled">disabled</ControlPlaneSelectItem><ControlPlaneSelectItem value="enabled">enabled</ControlPlaneSelectItem></ControlPlaneSelect></label>
      <DialogFooter class="wide"><Button type="button" variant="outline" @click="formOpen = false">{{ t("common.actions.cancel") }}</Button><Button type="submit" :disabled="saving || !canSaveProvider">{{ saving ? t("settings.userAccess.providers.saving") : t("common.actions.save") }}</Button></DialogFooter>
    </form></DialogContent></Dialog>

    <Dialog :open="Boolean(approveTarget)" @update:open="(open) => !open && (approveTarget = undefined)"><DialogContent><DialogHeader><DialogTitle>{{ t("settings.userAccess.approvals.approveTitle") }}</DialogTitle><DialogDescription>{{ approveTarget?.verifiedEmail || approveTarget?.subject }}</DialogDescription></DialogHeader><form class="provider-form" @submit.prevent="confirmApprove"><label class="wide"><span>{{ t("settings.userAccess.displayName") }}</span><Input v-model="approvalDraft.displayName" /></label><label class="wide"><span>{{ t("settings.userAccess.role") }}</span><ControlPlaneSelect v-model="approvalDraft.roleId"><ControlPlaneSelectItem v-for="role in activeRoles" :key="role.id" :value="role.id">{{ role.name }}</ControlPlaneSelectItem></ControlPlaneSelect></label><DialogFooter class="wide"><Button type="button" variant="outline" @click="approveTarget = undefined">{{ t("common.actions.cancel") }}</Button><Button type="submit" :disabled="saving || !approvalDraft.roleId">{{ t("settings.userAccess.approvals.approve") }}</Button></DialogFooter></form></DialogContent></Dialog>

    <AlertDialog :open="Boolean(removeTarget || rejectTarget)" @update:open="(open) => { if (!open) { removeTarget = undefined; rejectTarget = undefined; } }"><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{{ removeTarget ? t("settings.userAccess.providers.removeTitle", { name: removeTarget.name }) : t("settings.userAccess.approvals.rejectTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ removeTarget ? t("settings.userAccess.providers.removeDescription") : t("settings.userAccess.approvals.rejectDescription") }}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction :disabled="saving" @click="confirmDangerous">{{ removeTarget ? t("common.actions.delete") : t("settings.userAccess.approvals.reject") }}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import { Pencil, Plus, Power, Trash2, UserCheck, UserX } from "@lucide/vue";
import type { ControlPlaneExternalIdentityApprovalSummary, ControlPlaneIdentityProviderSummary } from "@task-handoff/protocol/control-plane-access";
import { approveControlPlaneExternalIdentity, controlPlaneQueryKeys, createControlPlaneIdentityProvider, rejectControlPlaneExternalIdentity, removeControlPlaneIdentityProvider, updateControlPlaneIdentityProvider, useExternalIdentityApprovalsQuery, useIdentityProvidersQuery, useRolesQuery } from "../../../api/queries";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { translateApiError } from "../../../i18n/apiError";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const { t } = useI18n();
const queryClient = useQueryClient();
const providers = useIdentityProvidersQuery();
const approvals = useExternalIdentityApprovalsQuery();
const roles = useRolesQuery();
const formOpen = ref(false), editingId = ref(""), saving = ref(false);
const removeTarget = ref<ControlPlaneIdentityProviderSummary>(), rejectTarget = ref<ControlPlaneExternalIdentityApprovalSummary>(), approveTarget = ref<ControlPlaneExternalIdentityApprovalSummary>();
const draft = reactive({ name: "", kind: "oidc" as "oidc" | "github", issuer: "", clientId: "", clientSecret: "", callbackUrl: "", loginPolicy: "existing-only" as "existing-only" | "admin-approved-create", status: "disabled" as "disabled" | "enabled" });
const approvalDraft = reactive({ displayName: "", roleId: "role_operator" });
const pendingApprovals = computed(() => (approvals.data.value || []).filter((approval) => approval.status === "pending" && Date.parse(approval.expiresAt) > Date.now()));
const activeRoles = computed(() => (roles.data.value || []).filter((role) => role.status === "active"));
const canSaveProvider = computed(() => draft.name.trim() && draft.clientId.trim() && draft.callbackUrl.trim() && (editingId.value || draft.clientSecret) && (draft.kind !== "oidc" || draft.issuer.trim()));
const errorText = (error: unknown) => translateApiError(error, t, t("settings.userAccess.failed"));
const providerName = (id: string) => providers.data.value?.find((provider) => provider.id === id)?.name || id;
function openCreate() { editingId.value = ""; Object.assign(draft, { name: "", kind: "oidc", issuer: "", clientId: "", clientSecret: "", callbackUrl: `${location.origin}/api/auth/external/callback`, loginPolicy: "existing-only", status: "disabled" }); formOpen.value = true; }
function openEdit(provider: ControlPlaneIdentityProviderSummary) { editingId.value = provider.id; Object.assign(draft, { name: provider.name, kind: provider.kind, issuer: provider.issuer || "", clientId: provider.clientId, clientSecret: "", callbackUrl: provider.callbackUrl, loginPolicy: provider.loginPolicy, status: provider.status }); formOpen.value = true; }
async function saveProvider() { saving.value = true; try { const input = { name: draft.name.trim(), kind: draft.kind, issuer: draft.kind === "oidc" ? draft.issuer.trim() : undefined, clientId: draft.clientId.trim(), ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}), callbackUrl: draft.callbackUrl.trim(), loginPolicy: draft.loginPolicy, status: draft.status }; if (editingId.value) await updateControlPlaneIdentityProvider(editingId.value, input); else await createControlPlaneIdentityProvider(input); formOpen.value = false; await providers.refetch(); showControlPlaneToast(t("settings.userAccess.providers.saved"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); } finally { saving.value = false; } }
async function toggleProvider(provider: ControlPlaneIdentityProviderSummary) { try { await updateControlPlaneIdentityProvider(provider.id, { status: provider.status === "enabled" ? "disabled" : "enabled" }); await providers.refetch(); } catch (error) { showControlPlaneToast(errorText(error)); } }
function openApproval(approval: ControlPlaneExternalIdentityApprovalSummary) { approveTarget.value = approval; Object.assign(approvalDraft, { displayName: approval.displayName || approval.verifiedEmail || "", roleId: activeRoles.value[0]?.id || "" }); }
async function confirmApprove() { if (!approveTarget.value) return; saving.value = true; try { await approveControlPlaneExternalIdentity(approveTarget.value.id, { displayName: approvalDraft.displayName.trim() || undefined, roleIds: [approvalDraft.roleId], nodeScope: { kind: "all" }, instanceScope: { kind: "inherit-node-scope" } }); approveTarget.value = undefined; await Promise.all([approvals.refetch(), queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.users })]); showControlPlaneToast(t("settings.userAccess.approvals.approved"), "success"); } catch (error) { showControlPlaneToast(errorText(error)); } finally { saving.value = false; } }
async function confirmDangerous() { saving.value = true; try { if (removeTarget.value) { await removeControlPlaneIdentityProvider(removeTarget.value.id); removeTarget.value = undefined; await providers.refetch(); } else if (rejectTarget.value) { await rejectControlPlaneExternalIdentity(rejectTarget.value.id); rejectTarget.value = undefined; await approvals.refetch(); } } catch (error) { showControlPlaneToast(errorText(error)); } finally { saving.value = false; } }
</script>

<style scoped>
.provider-management,.management-list,.management-primary,.approval-section{display:grid;gap:12px}.management-toolbar,.management-row,.management-actions,.management-primary>div{align-items:center;display:flex;gap:10px}.management-toolbar{justify-content:space-between}.management-toolbar>div,.approval-section>div{display:grid;gap:3px}.management-toolbar strong,.management-primary strong,.approval-section strong{font-size:14px}.management-toolbar p,.management-primary p,.approval-section p,.management-state,.management-meta{color:var(--text-muted);font-size:12px;margin:0}.management-row{border-bottom:1px solid var(--line);padding:12px 0}.management-primary{flex:1;min-width:0}.management-primary p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.management-badge{border:1px solid var(--line);border-radius:999px;color:var(--text-muted);font-size:12px;padding:1px 6px}.management-badge[data-status="enabled"]{color:var(--status-success)}.management-actions{margin-left:auto}.approval-section{border-top:1px solid var(--line);padding-top:16px}.provider-form{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}.provider-form label{display:grid;gap:6px;font-size:12px}.provider-form .wide{grid-column:1/-1}.provider-dialog{max-width:680px}.management-error{color:var(--status-danger);font-size:13px}@media(max-width:720px){.management-row{align-items:flex-start;flex-direction:column}.management-actions{margin-left:0}.provider-form{grid-template-columns:1fr}.provider-form .wide{grid-column:auto}}
</style>
