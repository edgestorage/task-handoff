<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="account-security-dialog">
      <div class="account-security-head">
        <DialogHeader>
          <DialogTitle>{{ t("settings.account.title") }}</DialogTitle>
          <DialogDescription>{{ t("settings.account.description") }}</DialogDescription>
        </DialogHeader>
        <DialogClose as-child>
          <Button type="button" variant="ghost" size="icon" :aria-label="t('common.actions.close')" :disabled="saving">
            <X :size="16" />
          </Button>
        </DialogClose>
      </div>

      <p v-if="!authSession.data.value?.enabled" class="account-security-state">
        {{ t("settings.account.authenticationRequired") }}
      </p>
      <form v-else class="account-security-form" @submit.prevent="submit">
        <label>
          <span>{{ t("settings.account.username") }}</span>
          <Input :model-value="authSession.data.value?.user?.primaryUsername || authSession.data.value?.user?.displayName || ''" autocomplete="username" disabled />
        </label>
        <label>
          <span>{{ t("settings.account.currentPassword") }}</span>
          <Input v-model="currentPassword" type="password" autocomplete="current-password" :disabled="saving" />
        </label>
        <label>
          <span>{{ t("settings.account.newPassword") }}</span>
          <Input v-model="newPassword" type="password" autocomplete="new-password" :disabled="saving" />
        </label>
        <label>
          <span>{{ t("settings.account.confirmPassword") }}</span>
          <Input v-model="confirmPassword" type="password" autocomplete="new-password" :disabled="saving" />
        </label>
        <p v-if="validationError" class="account-security-error" role="alert">{{ validationError }}</p>
        <DialogFooter>
          <Button type="submit" :disabled="!canSubmit">
            <KeyRound :size="14" />
            <span>{{ saving ? t("settings.account.saving") : t("settings.account.save") }}</span>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { KeyRound, X } from "@lucide/vue";
import { changeControlPlanePassword, controlPlaneQueryKeys, useAuthSessionQuery } from "../../../api/queries";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [open: boolean] }>();
const { t } = useI18n();
const queryClient = useQueryClient();
const authSession = useAuthSessionQuery();
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const saving = ref(false);
const submitted = ref(false);

const validationError = computed(() => {
  if (!submitted.value) return "";
  if (newPassword.value.length < 8) return t("settings.account.passwordLength");
  if (newPassword.value !== confirmPassword.value) return t("settings.account.passwordMismatch");
  return "";
});
const canSubmit = computed(() => Boolean(
  !saving.value
  && currentPassword.value
  && newPassword.value.length >= 8
  && newPassword.value === confirmPassword.value,
));

function resetDraft() {
  currentPassword.value = "";
  newPassword.value = "";
  confirmPassword.value = "";
  submitted.value = false;
}

function handleOpenChange(open: boolean) {
  if (saving.value) return;
  emit("update:open", open);
}

watch(() => props.open, (open) => {
  if (!open) resetDraft();
});

async function submit() {
  submitted.value = true;
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await changeControlPlanePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    resetDraft();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["auth-session"] }),
      queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.mobileSessions }),
    ]);
    showControlPlaneToast(t("settings.account.saved"), "success");
    emit("update:open", false);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("settings.account.saveFailed")));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.account-security-dialog { max-width: 520px; }
.account-security-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.account-security-head > :first-child { flex: 1; }
.account-security-state { color: var(--text-muted); font-size: 13px; margin: 0; padding: 12px 0; }
.account-security-form { display: grid; gap: 14px; }
.account-security-form label { display: grid; gap: 7px; }
.account-security-form label span { color: var(--text); font-size: 12px; font-weight: 400; }
.account-security-error { color: var(--status-danger); font-size: 12px; margin: 0; }
</style>
