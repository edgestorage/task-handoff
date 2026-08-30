<template>
  <div v-if="authSession.isLoading.value" class="auth-shell">
    <div class="auth-panel compact">
      <span class="auth-kicker">{{ t("auth.controlPlane") }}</span>
      <h1>{{ t("auth.loading") }}</h1>
    </div>
  </div>
  <slot v-else-if="authSession.data.value?.authenticated && !authSession.data.value.requiresPasswordChange" />
  <div v-else-if="authSession.data.value?.authenticated" class="auth-shell">
    <form class="auth-panel" @submit.prevent="changeTemporaryPassword">
      <span class="auth-kicker">{{ t("auth.controlPlane") }}</span>
      <h1>{{ t("auth.changeTemporaryPassword") }}</h1>
      <p>{{ t("auth.changeTemporaryPasswordDescription") }}</p>

      <label>
        <span>{{ t("auth.currentPassword") }}</span>
        <Input v-model="currentPassword" type="password" autocomplete="current-password" :disabled="busy" />
      </label>
      <label>
        <span>{{ t("auth.newPassword") }}</span>
        <Input v-model="newPassword" type="password" autocomplete="new-password" :disabled="busy" />
      </label>
      <label>
        <span>{{ t("auth.confirmPassword") }}</span>
        <Input v-model="confirmPassword" type="password" autocomplete="new-password" :disabled="busy" />
      </label>

      <p v-if="passwordValidationError" class="auth-error">{{ passwordValidationError }}</p>
      <Button class="auth-submit" type="submit" :disabled="busy || !canChangePassword">
        {{ busy ? t("auth.working") : t("auth.changePassword") }}
      </Button>
    </form>
  </div>
  <div v-else class="auth-shell">
    <form class="auth-panel" @submit.prevent="submit">
      <span class="auth-kicker">{{ t("auth.controlPlane") }}</span>
      <h1>{{ authSession.data.value?.requiresBootstrap ? t("auth.createAdmin") : t("auth.signIn") }}</h1>
      <p>{{ authSession.data.value?.requiresBootstrap ? t("auth.bootstrapDescription") : t("auth.signInDescription") }}</p>

      <label>
        <span>{{ t("auth.username") }}</span>
        <Input v-model="username" autocomplete="username" :disabled="busy" />
      </label>
      <label>
        <span>{{ t("auth.password") }}</span>
        <Input v-model="password" type="password" :autocomplete="authSession.data.value?.requiresBootstrap ? 'new-password' : 'current-password'" :disabled="busy" />
      </label>

      <p v-if="errorText" class="auth-error">{{ errorText }}</p>
      <Button class="auth-submit" type="submit" :disabled="busy || !username.trim() || password.length < 1">
        {{ busy ? t("auth.working") : authSession.data.value?.requiresBootstrap ? t("auth.createAdmin") : t("auth.signIn") }}
      </Button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bootstrapAdmin, changeControlPlanePassword, loginControlPlane, useAuthSessionQuery } from "@/api/queries";
import { translateApiError } from "@/i18n/apiError";

const queryClient = useQueryClient();
const { t } = useI18n();
const authSession = useAuthSessionQuery();
const username = ref("");
const password = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const errorText = ref("");
const submitting = ref(false);
const busy = computed(() => submitting.value || authSession.isFetching.value);
const passwordValidationError = computed(() => {
  if (newPassword.value && newPassword.value.length < 8) return t("auth.passwordLength");
  if (confirmPassword.value && newPassword.value !== confirmPassword.value) return t("auth.passwordMismatch");
  return errorText.value;
});
const canChangePassword = computed(() => Boolean(
  currentPassword.value
  && newPassword.value.length >= 8
  && newPassword.value === confirmPassword.value,
));

async function submit() {
  if (busy.value) return;
  submitting.value = true;
  errorText.value = "";
  try {
    const payload = { username: username.value.trim(), password: password.value };
    if (authSession.data.value?.requiresBootstrap) {
      await bootstrapAdmin(payload);
    }
    await loginControlPlane(payload);
    password.value = "";
    await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
  } catch (error) {
    errorText.value = translateApiError(error, t);
  } finally {
    submitting.value = false;
  }
}

async function changeTemporaryPassword() {
  if (busy.value || !canChangePassword.value) return;
  submitting.value = true;
  errorText.value = "";
  try {
    await changeControlPlanePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value });
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
  } catch (error) {
    errorText.value = translateApiError(error, t);
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.auth-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  background:
    linear-gradient(180deg, var(--surface-raised), var(--surface-inset)),
    var(--workspace-bg);
  padding: 24px;
}

.auth-panel {
  display: grid;
  width: min(100%, 380px);
  gap: 14px;
  border: 1px solid var(--line-subtle);
  border-radius: 8px;
  background: var(--surface-overlay);
  padding: 24px;
  box-shadow: var(--shadow-panel);
}

.auth-panel.compact {
  justify-items: start;
}

.auth-kicker {
  color: var(--brand-accent-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.auth-panel h1 {
  margin: 0;
  color: var(--text-strong);
  font-size: 24px;
  font-weight: 750;
  line-height: 1.15;
}

.auth-panel p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.auth-panel label {
  display: grid;
  gap: 7px;
}

.auth-panel label span {
  color: var(--text);
  font-size: 12px;
  font-weight: 650;
}

.auth-error {
  color: var(--status-danger) !important;
}

.auth-submit {
  margin-top: 2px;
}
</style>
