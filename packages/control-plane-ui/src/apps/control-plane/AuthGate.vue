<template>
  <div v-if="authSession.isLoading.value" class="auth-shell">
    <span class="auth-mark loading" role="img" :aria-label="t('auth.loading')" />
  </div>
  <slot v-else-if="authSession.data.value?.authenticated && !authSession.data.value.requiresPasswordChange" />
  <div v-else class="auth-shell auth-shell--split">
    <aside class="auth-showcase">
      <div class="auth-brand">
        <span class="auth-lockup">
          <span class="auth-mark auth-mark--showcase" aria-hidden="true" />
          <!-- i18n-audit-allow-next-line product-name: official product spelling -->
          <span class="auth-wordmark">TaskHandoff</span>
        </span>
        <p class="auth-tagline">{{ t("auth.brandTagline") }}</p>
        <ul class="auth-links">
          <li>
            <a :href="productSiteUrl" target="_blank" rel="noopener noreferrer">
              <Globe class="auth-link-icon" aria-hidden="true" />
              <span>{{ t("auth.linkWebsite") }}</span>
            </a>
          </li>
          <li>
            <a :href="productDocsUrl" target="_blank" rel="noopener noreferrer">
              <BookOpen class="auth-link-icon" aria-hidden="true" />
              <span>{{ t("auth.linkDocs") }}</span>
            </a>
          </li>
          <li>
            <a :href="PRODUCT_REPOSITORY_URL" target="_blank" rel="noopener noreferrer">
              <span class="auth-link-icon auth-link-icon--mark" aria-hidden="true" />
              <span>{{ t("auth.linkGithub") }}</span>
            </a>
          </li>
        </ul>
      </div>
    </aside>

    <main class="auth-panel">
      <form v-if="authSession.data.value?.authenticated" class="auth-form" @submit.prevent="changeTemporaryPassword">
        <header class="auth-head">
          <h1>{{ t("auth.changeTemporaryPassword") }}</h1>
          <p>{{ t("auth.changeTemporaryPasswordDescription") }}</p>
        </header>

        <div class="auth-fields">
          <label>
            <span>{{ t("auth.currentPassword") }}</span>
            <Input v-model="currentPassword" class="auth-field" type="password" autocomplete="current-password" :disabled="busy" />
          </label>
          <label>
            <span>{{ t("auth.newPassword") }}</span>
            <Input v-model="newPassword" class="auth-field" type="password" autocomplete="new-password" :disabled="busy" />
          </label>
          <label>
            <span>{{ t("auth.confirmPassword") }}</span>
            <Input v-model="confirmPassword" class="auth-field" type="password" autocomplete="new-password" :disabled="busy" />
          </label>
        </div>

        <p v-if="passwordValidationError" class="auth-error">{{ passwordValidationError }}</p>
        <Button class="auth-submit" type="submit" :disabled="busy || !canChangePassword">
          {{ busy ? t("auth.working") : t("auth.changePassword") }}
        </Button>
      </form>
      <form v-else class="auth-form" @submit.prevent="submit">
        <header class="auth-head">
          <h1>{{ authSession.data.value?.requiresBootstrap ? t("auth.createAdmin") : t("auth.signIn") }}</h1>
          <p>{{ authSession.data.value?.requiresBootstrap ? t("auth.bootstrapDescription") : t("auth.signInDescription") }}</p>
        </header>

        <div class="auth-fields">
          <label>
            <span>{{ t("auth.username") }}</span>
            <Input v-model="username" class="auth-field" autocomplete="username" :disabled="busy" />
          </label>
          <label>
            <span>{{ t("auth.password") }}</span>
            <Input v-model="password" class="auth-field" type="password" :autocomplete="authSession.data.value?.requiresBootstrap ? 'new-password' : 'current-password'" :disabled="busy" />
          </label>
        </div>

        <p v-if="errorText" class="auth-error">{{ errorText }}</p>
        <Button class="auth-submit" type="submit" :disabled="busy || !username.trim() || password.length < 1">
          {{ busy ? t("auth.working") : authSession.data.value?.requiresBootstrap ? t("auth.createAdmin") : t("auth.signIn") }}
        </Button>
      </form>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryClient } from "@tanstack/vue-query";
import { BookOpen, Globe } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bootstrapAdmin, changeControlPlanePassword, loginControlPlane, useAuthSessionQuery } from "@/api/queries";
import { translateApiError } from "@/i18n/apiError";

const PRODUCT_SITE_ORIGIN = "https://docs.thandoff.com";
const PRODUCT_REPOSITORY_URL = "https://github.com/edgestorage/task-handoff";

const queryClient = useQueryClient();
const { t, locale } = useI18n();
const authSession = useAuthSessionQuery();
const productSiteUrl = computed(() => `${PRODUCT_SITE_ORIGIN}/${locale.value === "zh-CN" ? "zh" : "en"}/`);
const productDocsUrl = computed(() => `${productSiteUrl.value}guide/`);
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
  /* Single source for the brand mark and the wordmark so they always match. */
  --auth-logo-fill: color-mix(in srgb, var(--brand-accent-muted) 70%, transparent);
  display: grid;
  place-items: center;
  min-height: 100vh;
  background: var(--workspace-bg);
  padding: 48px 24px;
}

.auth-shell--split {
  grid-template-columns: minmax(240px, 34%) minmax(0, 1fr);
  place-items: stretch;
  padding: 0;
}

.auth-mark {
  width: 64px;
  height: 64px;
  background: var(--auth-logo-fill);
  mask: url("../../assets/task-handoff-logo.svg") center / contain no-repeat;
}

.auth-mark.loading {
  animation: auth-mark-pulse 1.6s ease-in-out infinite;
}

@keyframes auth-mark-pulse {
  50% { opacity: 0.6; }
}

@media (prefers-reduced-motion: reduce) {
  .auth-mark.loading {
    animation: none;
  }
}

.auth-showcase {
  position: relative;
  display: grid;
  align-content: center;
  justify-items: center;
  overflow: hidden;
  padding: 56px;
}

.auth-showcase::before {
  content: "";
  position: absolute;
  inset: -30% -20%;
  background: radial-gradient(circle at 50% 50%, var(--brand-accent-soft), transparent 60%);
  pointer-events: none;
}

.auth-showcase > * {
  position: relative;
}

.auth-brand {
  display: grid;
  justify-items: start;
  gap: 16px;
  width: min(100%, 320px);
}

.auth-lockup {
  display: flex;
  align-items: center;
  gap: 9px;
}

.auth-mark--showcase {
  width: 26px;
  height: 26px;
}

.auth-wordmark {
  color: var(--auth-logo-fill);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.auth-tagline {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.7;
}

.auth-links {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.auth-links a {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
  text-decoration: none;
  transition: color 150ms ease;
}

.auth-links a:hover,
.auth-links a:focus-visible {
  color: var(--text-strong);
}

.auth-links a:hover .auth-link-icon,
.auth-links a:focus-visible .auth-link-icon {
  color: var(--brand-accent);
}

.auth-link-icon {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  color: var(--text-subtle);
  transition: color 150ms ease;
}

.auth-link-icon--mark {
  background: currentColor;
  mask: url("../../assets/github-mark.svg") center / contain no-repeat;
}

.auth-panel {
  position: relative;
  display: grid;
  align-content: center;
  justify-items: center;
  padding: 48px;
}

.auth-panel::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, var(--line-subtle) 18%, var(--line-subtle) 82%, transparent);
}

.auth-form {
  display: grid;
  width: min(100%, 320px);
  gap: 22px;
}

.auth-head {
  display: grid;
  gap: 8px;
}

.auth-head h1 {
  margin: 0;
  color: var(--text-strong);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.25;
}

.auth-head p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.auth-fields {
  display: grid;
  gap: 14px;
}

.auth-form label {
  display: grid;
  gap: 6px;
}

.auth-form label span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
}

.auth-field {
  height: 40px;
  border-radius: 9px;
  background: var(--surface);
  padding: 0 12px;
  font-size: 14px;
}

.auth-submit {
  width: 100%;
  height: 40px;
  border-radius: 9px;
  font-size: 14px;
  font-weight: 500;
}

.auth-form p.auth-error {
  color: var(--status-danger);
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 880px) {
  .auth-shell--split {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .auth-showcase {
    padding: 32px 24px 20px;
  }

  .auth-brand {
    gap: 12px;
  }

  .auth-links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
  }

  .auth-panel {
    align-content: center;
    padding: 32px 24px 48px;
  }

  .auth-panel::before {
    inset: 0 0 auto;
    width: auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--line-subtle) 18%, var(--line-subtle) 82%, transparent);
  }
}
</style>
