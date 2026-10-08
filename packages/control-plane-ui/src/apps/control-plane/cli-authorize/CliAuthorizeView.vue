<template>
  <div class="cli-authorize-shell">
    <section class="cli-authorize-panel">
      <span class="cli-authorize-kicker">{{ t("cliAuthorize.kicker") }}</span>

      <template v-if="completed === 'approved'">
        <h1>{{ t("cliAuthorize.approvedTitle") }}</h1>
        <p>{{ request?.mode === "device" ? t("cliAuthorize.approvedDevice") : t("cliAuthorize.approvedBrowser") }}</p>
      </template>
      <template v-else-if="completed === 'denied'">
        <h1>{{ t("cliAuthorize.deniedTitle") }}</h1>
        <p>{{ t("cliAuthorize.deniedDescription") }}</p>
      </template>
      <template v-else-if="request">
        <h1>{{ t("cliAuthorize.title") }}</h1>
        <p>{{ t("cliAuthorize.description") }}</p>
        <dl class="cli-authorize-facts">
          <div><dt>{{ t("cliAuthorize.client") }}</dt><dd>{{ request.client.name }}</dd></div>
          <div><dt>{{ t("cliAuthorize.platform") }}</dt><dd>{{ platformLabel }}</dd></div>
          <div v-if="request.client.version"><dt>{{ t("cliAuthorize.version") }}</dt><dd>{{ request.client.version }}</dd></div>
          <div><dt>{{ t("cliAuthorize.requestedAt") }}</dt><dd>{{ formatDateTime(request.createdAt) }}</dd></div>
          <div><dt>{{ t("cliAuthorize.expiresAt") }}</dt><dd>{{ formatDateTime(request.expiresAt) }}</dd></div>
        </dl>
        <p v-if="request.status !== 'pending'" class="cli-authorize-notice">{{ statusNotice }}</p>
        <p v-if="errorText" class="cli-authorize-error">{{ errorText }}</p>
        <div class="cli-authorize-actions">
          <Button :disabled="busy || request.status !== 'pending'" @click="approve">{{ t("cliAuthorize.approve") }}</Button>
          <Button variant="outline" :disabled="busy || request.status !== 'pending'" @click="deny">{{ t("cliAuthorize.deny") }}</Button>
        </div>
      </template>
      <template v-else>
        <h1>{{ t("cliAuthorize.manualTitle") }}</h1>
        <p>{{ t("cliAuthorize.manualDescription") }}</p>
        <form class="cli-authorize-form" @submit.prevent="submitUserCode">
          <Input v-model="userCodeInput" :placeholder="t('cliAuthorize.userCodePlaceholder')" :disabled="busy" />
          <Button type="submit" :disabled="busy || !userCodeInput.trim()">{{ t("cliAuthorize.continue") }}</Button>
        </form>
        <p v-if="errorText" class="cli-authorize-error">{{ errorText }}</p>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  approveCliAuthorization,
  denyCliAuthorization,
  useCliAuthorizationRequestByUserCodeQuery,
  useCliAuthorizationRequestQuery,
} from "@/api/queries";
import { translateApiError } from "@/i18n/apiError";

const { t, locale } = useI18n();
const params = new URLSearchParams(window.location.search);
const requestId = ref(params.get("request")?.trim() || undefined);
const userCode = ref(params.get("user_code")?.trim() || undefined);
const userCodeInput = ref("");
const completed = ref<"approved" | "denied" | undefined>();
const errorText = ref("");
const busy = ref(false);

const byRequest = useCliAuthorizationRequestQuery(requestId);
const byUserCode = useCliAuthorizationRequestByUserCodeQuery(userCode);
const request = computed(() => byRequest.data.value || byUserCode.data.value);
const platformLabel = computed(() => {
  const platform = request.value?.client.platform;
  return platform ? t(`cliAuthorize.platforms.${platform}`) : "";
});
const statusNotice = computed(() => {
  const status = request.value?.status;
  if (status === "expired") return t("cliAuthorize.statusExpired");
  if (status === "denied") return t("cliAuthorize.statusDenied");
  if (status === "consumed") return t("cliAuthorize.statusConsumed");
  return t("cliAuthorize.statusApproved");
});

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function submitUserCode() {
  const normalized = userCodeInput.value.trim().toUpperCase();
  if (!normalized) return;
  errorText.value = "";
  userCode.value = normalized;
}

async function approve() {
  if (!request.value || busy.value) return;
  busy.value = true;
  errorText.value = "";
  try {
    const result = await approveCliAuthorization(request.value.requestId);
    if (result.redirectUri) {
      window.location.replace(result.redirectUri);
      return;
    }
    completed.value = "approved";
  } catch (error) {
    errorText.value = translateApiError(error, t);
  } finally {
    busy.value = false;
  }
}

async function deny() {
  if (!request.value || busy.value) return;
  busy.value = true;
  errorText.value = "";
  try {
    await denyCliAuthorization(request.value.requestId);
    completed.value = "denied";
  } catch (error) {
    errorText.value = translateApiError(error, t);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.cli-authorize-shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  background: var(--workspace-bg);
  padding: 24px;
}

.cli-authorize-panel {
  display: grid;
  width: min(100%, 420px);
  gap: 14px;
  border: 1px solid var(--line-subtle);
  border-radius: 14px;
  background: var(--surface-raised);
  padding: 24px;
}

.cli-authorize-kicker {
  color: var(--text-muted);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.cli-authorize-panel h1 {
  font-size: 18px;
  font-weight: 500;
}

.cli-authorize-panel p {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.cli-authorize-facts {
  display: grid;
  gap: 8px;
  border: 1px solid var(--line-subtle);
  border-radius: 10px;
  background: var(--surface-inset);
  padding: 12px 14px;
}

.cli-authorize-facts div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.cli-authorize-facts dt {
  color: var(--text-muted);
  font-size: 12px;
}

.cli-authorize-facts dd {
  font-size: 13px;
  text-align: right;
}

.cli-authorize-actions {
  display: flex;
  gap: 10px;
}

.cli-authorize-form {
  display: grid;
  gap: 10px;
}

.cli-authorize-error {
  color: var(--danger-fg, #dc2626);
  font-size: 12px;
}

.cli-authorize-notice {
  font-size: 12px;
}
</style>
