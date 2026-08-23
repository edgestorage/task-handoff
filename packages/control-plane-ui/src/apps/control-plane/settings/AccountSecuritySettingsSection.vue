<template>
  <ScrollArea class="settings-section-scroll" :horizontal="false">
    <div class="settings-section-scroll-content account-security-settings">
      <section class="modal-section settings-panel-surface account-security-panel">
        <header>
          <strong>{{ t("settings.account.title") }}</strong>
          <p>{{ t("settings.account.description") }}</p>
        </header>

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
          <div class="account-security-actions">
            <Button type="submit" :disabled="!canSubmit">
              <KeyRound :size="14" />
              <span>{{ saving ? t("settings.account.saving") : t("settings.account.save") }}</span>
            </Button>
          </div>
        </form>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { KeyRound } from "@lucide/vue";
import { changeControlPlanePassword, controlPlaneQueryKeys, useAuthSessionQuery } from "../../../api/queries";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { translateApiError } from "../../../i18n/apiError";
import { showControlPlaneToast } from "../useControlPlaneToasts";

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

async function submit() {
  submitted.value = true;
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await changeControlPlanePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    submitted.value = false;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["auth-session"] }),
      queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.mobileSessions }),
    ]);
    showControlPlaneToast(t("settings.account.saved"), "success");
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("settings.account.saveFailed")));
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.account-security-settings { max-width: 680px; }
.account-security-panel { align-content: start; }
.account-security-panel header { display: grid; gap: 4px; }
.account-security-panel header strong { color: var(--text-strong); font-size: 15px; }
.account-security-panel header p { color: var(--text-muted); font-size: 13px; line-height: 1.5; margin: 0; }
.account-security-state { color: var(--text-muted); font-size: 13px; margin: 0; padding: 24px 0; }
.account-security-form { display: grid; gap: 14px; margin-top: 20px; max-width: 440px; }
.account-security-form label { display: grid; gap: 7px; }
.account-security-form label span { color: var(--text); font-size: 12px; font-weight: 650; }
.account-security-error { color: var(--status-danger); font-size: 12px; margin: 0; }
.account-security-actions { display: flex; justify-content: flex-end; padding-top: 2px; }
</style>
