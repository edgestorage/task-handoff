<template>
  <div class="install-environment">
    <div class="install-environment-heading">
      <div>
        <h3>{{ t("instances.settings.installEnvironment") }}</h3>
        <p>{{ t("instances.settings.installEnvironmentDescription") }}</p>
      </div>
      <span v-if="environment" class="install-environment-revision">{{ t("instances.settings.installSourceRevision", { revision: environment.revision }) }}</span>
    </div>

    <div class="install-environment-panel">
      <div class="install-environment-row">
        <div class="install-environment-row-copy">
          <strong>{{ t("instances.settings.installSourceProfile") }}</strong>
          <small>{{ t("instances.settings.installSourceProfileDescription") }}</small>
        </div>
        <ControlPlaneSelect v-model="profile" :aria-label="t('instances.settings.installSourceProfile')" :disabled="busy">
          <ControlPlaneSelectItem value="environment">{{ t("instances.settings.installSourceEnvironment") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="official">{{ t("instances.settings.installSourceOfficial") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="china">{{ t("instances.settings.installSourceChina") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="custom">{{ t("instances.settings.installSourceCustom") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <div v-if="profile === 'custom'" class="install-environment-custom">
        <div class="install-environment-custom-heading">
          <strong>{{ t("instances.settings.installSourceCustomEndpoints") }}</strong>
          <small>{{ t("instances.settings.installSourceCustomEndpointsDescription") }}</small>
        </div>
        <div class="install-environment-custom-grid">
          <label v-for="field in customFields" :key="field.key">
            <span>{{ field.label }}</span>
            <ControlPlaneInput v-model="custom[field.key]" :disabled="busy" :placeholder="t('instances.settings.installSourceUrlPlaceholder')" />
          </label>
        </div>
      </div>

      <div class="install-environment-row install-environment-runtime" :class="runtimeStateClass">
        <div class="install-environment-row-copy">
          <div class="install-environment-runtime-title">
            <strong>{{ t("instances.settings.nodeToolchain") }}</strong>
            <span class="install-environment-runtime-state"><span class="install-environment-state-dot" aria-hidden="true" />{{ nodeStateLabel }}</span>
          </div>
          <small v-if="nodeStatus">{{ t("instances.settings.nodeToolchainMinimum", { version: nodeStatus.minimumVersion, managed: nodeStatus.managedVersion }) }}</small>
          <small v-if="nodeStatus?.reason" class="install-environment-runtime-reason">{{ nodeStatus.reason }}</small>
        </div>
        <div class="install-environment-runtime-side">
          <dl v-if="nodeStatus?.version" class="install-environment-runtime-metrics">
            <div><dt>{{ t("instances.settings.nodejsLabel") }}</dt><dd><code>{{ nodeStatus.version }}</code></dd></div>
            <div><dt>{{ t("instances.settings.npmLabel") }}</dt><dd><code>{{ nodeStatus.npmVersion || "—" }}</code></dd></div>
          </dl>
          <Button v-if="canPrepareToolchain" size="sm" variant="outline" :disabled="busy" @click="prepareToolchain">
            <LoaderCircle v-if="preparing" class="animate-spin motion-reduce:animate-none" :size="13" />
            {{ preparing ? t("instances.settings.preparingNodeToolchain") : t("instances.settings.prepareNodeToolchain") }}
          </Button>
        </div>
      </div>

      <div class="install-environment-effective">
        <div class="install-environment-effective-heading">
          <strong>{{ t("instances.settings.effectiveSources") }}</strong>
          <small v-if="changed">{{ t("instances.settings.effectiveSourcesPending") }}</small>
        </div>
        <p v-if="!changed && !effectiveRows.length">{{ t("instances.settings.effectiveSourcesEnvironment") }}</p>
        <dl v-else-if="!changed" class="install-environment-effective-grid">
          <div v-for="row in effectiveRows" :key="row.label"><dt>{{ row.label }}</dt><dd><code>{{ row.value }}</code></dd></div>
        </dl>
      </div>

      <div v-if="checks" class="install-environment-checks" role="status" aria-live="polite">
        <strong>{{ t("instances.settings.installSourceChecks") }}</strong>
        <p v-if="!checks.length">{{ t("instances.settings.installSourceChecksEmpty") }}</p>
        <ul v-else>
          <li v-for="check in checks" :key="check.id">
            <CircleCheck v-if="check.ok" class="install-environment-check-icon is-ok" :size="15" aria-hidden="true" />
            <CircleAlert v-else class="install-environment-check-icon" :size="15" aria-hidden="true" />
            <span class="install-environment-check-copy">
              <span>{{ checkLabel(check.id) }}</span>
              <code>{{ check.url }}</code>
              <small v-if="check.message">{{ check.message }}</small>
            </span>
            <span class="install-environment-check-result" :class="{ 'is-ok': check.ok }">{{ check.ok ? t("instances.settings.installSourceCheckOk") : t("instances.settings.installSourceCheckFailed") }}</span>
          </li>
        </ul>
      </div>

      <p v-if="error" class="install-environment-error" role="alert">{{ error }}</p>

      <div class="install-environment-actions">
        <span v-if="changed" class="install-environment-unsaved">{{ t("instances.settings.installSourcesChanged") }}</span>
        <div class="install-environment-buttons">
          <Button size="sm" variant="outline" :disabled="busy || !environment || changed" :title="changed ? t('instances.settings.installSourcesTestNeedsSave') : undefined" @click="testConnections">
            <LoaderCircle v-if="testing" class="animate-spin motion-reduce:animate-none" :size="13" />
            {{ testing ? t("instances.settings.installSourcesTesting") : t("instances.settings.testInstallSources") }}
          </Button>
          <Button size="sm" :disabled="busy || !changed" @click="save">
            <LoaderCircle v-if="saving" class="animate-spin motion-reduce:animate-none" :size="13" />
            {{ saving ? t("instances.settings.installSourcesSaving") : t("instances.settings.saveInstallSources") }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CircleAlert, CircleCheck, LoaderCircle } from "@lucide/vue";
import type { AppInstallEnvironment, AppInstallEnvironmentTestCheck, AppInstallSourceProfile } from "../../../api/types";
import { prepareInstanceInstallEnvironment, testInstanceInstallEnvironment, updateInstanceInstallEnvironment } from "../../../api/queries";
import { Button } from "../../../components/ui/button";
import { translateApiError } from "../../../i18n/apiError";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{
  instanceId: string;
  environment?: AppInstallEnvironment;
  aptSupported: boolean;
  nodeToolchainSupported: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
const { t } = useI18n();
const profile = ref<AppInstallSourceProfile>("environment");
const custom = reactive({
  npmRegistry: "",
  nodeDistUrl: "",
  aptMainMirror: "",
  aptSecurityMirror: "",
});
const saving = ref(false);
const testing = ref(false);
const preparing = ref(false);
const error = ref("");
const checks = ref<AppInstallEnvironmentTestCheck[]>();
const busy = computed(() => saving.value || testing.value || preparing.value);

const customFields = computed(() => ([
  { key: "npmRegistry" as const, label: t("instances.settings.npmRegistry") },
  { key: "nodeDistUrl" as const, label: t("instances.settings.nodeDistUrl") },
  ...(props.aptSupported ? [
    { key: "aptMainMirror" as const, label: t("instances.settings.aptMainMirror") },
    { key: "aptSecurityMirror" as const, label: t("instances.settings.aptSecurityMirror") },
  ] : []),
]));

function hydrate() {
  const settings = props.environment?.settings;
  profile.value = settings?.profile || "environment";
  custom.npmRegistry = settings?.custom.npmRegistry || "";
  custom.nodeDistUrl = settings?.custom.nodeDistUrl || "";
  custom.aptMainMirror = settings?.custom.aptMainMirror || "";
  custom.aptSecurityMirror = settings?.custom.aptSecurityMirror || "";
  checks.value = undefined;
  error.value = "";
}

watch(() => [props.instanceId, props.environment?.revision] as const, hydrate, { immediate: true });

watch([profile, custom], () => {
  checks.value = undefined;
}, { deep: true });

const changed = computed(() => {
  const settings = props.environment?.settings;
  return profile.value !== (settings?.profile || "environment")
    || custom.npmRegistry !== (settings?.custom.npmRegistry || "")
    || custom.nodeDistUrl !== (settings?.custom.nodeDistUrl || "")
    || custom.aptMainMirror !== (settings?.custom.aptMainMirror || "")
    || custom.aptSecurityMirror !== (settings?.custom.aptSecurityMirror || "");
});

const nodeStatus = computed(() => props.environment?.node);
const canPrepareToolchain = computed(() => props.nodeToolchainSupported
  && nodeStatus.value?.state === "missing"
  && !nodeStatus.value.reason);
const runtimeStateClass = computed(() => {
  if (nodeStatus.value?.reason) return "is-unavailable";
  if (nodeStatus.value?.state === "missing") return "is-missing";
  if (nodeStatus.value?.state === "private") return "is-private";
  return "is-host";
});
const nodeStateLabel = computed(() => {
  if (!nodeStatus.value) return t("instances.settings.nodeToolchainMissing");
  if (nodeStatus.value.state === "host") return t("instances.settings.nodeToolchainHost");
  if (nodeStatus.value.state === "private") return t("instances.settings.nodeToolchainPrivate");
  return nodeStatus.value.reason
    ? t("instances.settings.nodeToolchainUnavailable")
    : t("instances.settings.nodeToolchainMissing");
});

const effectiveRows = computed(() => {
  const effective = props.environment?.effective;
  if (!effective) return [];
  return [
    { label: t("instances.settings.npmRegistry"), value: effective.npmRegistry },
    { label: t("instances.settings.nodeDistUrl"), value: effective.nodeDistUrl },
    { label: t("instances.settings.aptMainMirror"), value: effective.aptMainMirror },
    { label: t("instances.settings.aptSecurityMirror"), value: effective.aptSecurityMirror },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
});

function checkLabel(id: AppInstallEnvironmentTestCheck["id"]) {
  if (id === "npm") return t("instances.settings.npmRegistry");
  if (id === "node") return t("instances.settings.nodeDistUrl");
  if (id === "apt-main") return t("instances.settings.aptMainMirror");
  return t("instances.settings.aptSecurityMirror");
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    await updateInstanceInstallEnvironment(props.instanceId, {
      ...(props.environment ? { expectedRevision: props.environment.revision } : {}),
      settings: {
        profile: profile.value,
        custom: profile.value === "custom"
          ? Object.fromEntries(Object.entries(custom).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim().replace(/\/+$/, "")]))
          : {},
      },
    });
    showControlPlaneToast(t("instances.settings.installSourcesSaved"), "success");
    emit("refresh");
  } catch (cause) {
    error.value = translateApiError(cause, t, t("instances.settings.installSourcesSaveFailed"));
  } finally {
    saving.value = false;
  }
}

async function testConnections() {
  testing.value = true;
  error.value = "";
  try {
    checks.value = (await testInstanceInstallEnvironment(props.instanceId)).checks;
  } catch (cause) {
    error.value = translateApiError(cause, t, t("instances.settings.installSourcesTestFailed"));
  } finally {
    testing.value = false;
  }
}

async function prepareToolchain() {
  preparing.value = true;
  error.value = "";
  try {
    await prepareInstanceInstallEnvironment(props.instanceId);
    showControlPlaneToast(t("instances.settings.nodeToolchainPrepared"), "success");
    emit("refresh");
  } catch (cause) {
    error.value = translateApiError(cause, t, t("instances.settings.prepareNodeToolchainFailed"));
  } finally {
    preparing.value = false;
  }
}
</script>

<style scoped>
.install-environment { display: grid; gap: 14px; }
.install-environment-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.install-environment-heading h3 { margin: 0; color: var(--text-strong); font-size: 14px; font-weight: 600; }
.install-environment-heading p { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
.install-environment-revision { flex-shrink: 0; color: var(--text-muted); font-size: 12px; }
.install-environment-panel { overflow: hidden; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-raised); }
.install-environment-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 320px); align-items: center; gap: 20px; padding: 14px 16px; }
.install-environment-row + .install-environment-row,
.install-environment-custom + .install-environment-row,
.install-environment-custom,
.install-environment-effective,
.install-environment-checks,
.install-environment-error,
.install-environment-actions { border-top: 1px solid var(--line); }
.install-environment-row-copy { display: grid; min-width: 0; gap: 4px; }
.install-environment-row-copy > strong,
.install-environment-runtime-title strong,
.install-environment-custom-heading strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.install-environment-row-copy small,
.install-environment-custom-heading small { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.install-environment-custom { display: grid; gap: 10px; padding: 14px 16px; background: var(--surface-inset); }
.install-environment-custom-heading { display: grid; gap: 3px; }
.install-environment-custom-heading strong { font-size: 12px; }
.install-environment-custom-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
.install-environment-custom-grid label { display: grid; min-width: 0; gap: 5px; }
.install-environment-custom-grid label > span { color: var(--text); font-size: 12px; font-weight: 500; }
.install-environment-runtime-title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.install-environment-runtime-state { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 12px; }
.install-environment-state-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 999px; background: currentColor; }
.install-environment-runtime.is-host .install-environment-runtime-state,
.install-environment-runtime.is-private .install-environment-runtime-state { color: var(--status-success); }
.install-environment-runtime.is-missing .install-environment-runtime-state { color: var(--status-warning, #b7791f); }
.install-environment-runtime.is-unavailable .install-environment-runtime-state,
.install-environment-runtime-reason { color: var(--status-danger); }
.install-environment-runtime-reason { font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.install-environment-runtime-side { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px 14px; }
.install-environment-runtime-metrics { display: flex; gap: 14px; margin: 0; }
.install-environment-runtime-metrics div { display: grid; gap: 1px; }
.install-environment-runtime-metrics dt { color: var(--text-muted); font-size: 12px; }
.install-environment-runtime-metrics dd { margin: 0; }
.install-environment-runtime-metrics code { color: var(--text-strong); font-size: 12px; }
.install-environment-runtime-side button { font-size: 12px; font-weight: 400; }
.install-environment-effective { display: grid; gap: 9px; padding: 14px 16px; background: var(--surface-inset); }
.install-environment-effective-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.install-environment-effective-heading strong,
.install-environment-checks > strong { color: var(--text); font-size: 12px; font-weight: 500; }
.install-environment-effective-heading small,
.install-environment-effective p,
.install-environment-checks p { margin: 0; color: var(--text-muted); font-size: 12px; }
.install-environment-effective-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 20px; margin: 0; }
.install-environment-effective-grid div { display: grid; min-width: 0; gap: 2px; }
.install-environment-effective-grid dt { color: var(--text-muted); font-size: 12px; }
.install-environment-effective-grid dd { margin: 0; }
.install-environment-effective-grid code { color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
.install-environment-checks { display: grid; gap: 8px; padding: 14px 16px; }
.install-environment-checks ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.install-environment-checks li { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: start; gap: 8px; padding: 8px 0; }
.install-environment-checks li + li { border-top: 1px solid var(--line); }
.install-environment-check-icon { margin-top: 1px; color: var(--status-danger); }
.install-environment-check-icon.is-ok,
.install-environment-check-result.is-ok { color: var(--status-success); }
.install-environment-check-copy { display: grid; min-width: 0; gap: 2px; }
.install-environment-check-copy > span { color: var(--text); font-size: 12px; font-weight: 500; }
.install-environment-check-copy code { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.install-environment-check-copy small { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.install-environment-check-result { color: var(--status-danger); font-size: 12px; white-space: nowrap; }
.install-environment-error { margin: 0; padding: 10px 16px; background: var(--surface-inset); color: var(--status-danger); font-size: 12px; }
.install-environment-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 12px; padding: 10px 16px; }
.install-environment-unsaved { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 12px; }
.install-environment-unsaved::before { width: 6px; height: 6px; border-radius: 999px; background: var(--status-warning, #b7791f); content: ""; }
.install-environment-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.install-environment-buttons button { font-size: 12px; font-weight: 400; }
@media (max-width: 680px) {
  .install-environment-heading { display: grid; }
  .install-environment-row { grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; }
  .install-environment-custom-grid,
  .install-environment-effective-grid { grid-template-columns: minmax(0, 1fr); }
  .install-environment-runtime-side { justify-content: flex-start; }
  .install-environment-actions { align-items: flex-start; }
  .install-environment-buttons { width: 100%; justify-content: flex-end; }
}
</style>
