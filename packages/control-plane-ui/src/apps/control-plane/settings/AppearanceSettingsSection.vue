<template>
  <ScrollArea class="basic-settings-scroll">
    <div class="basic-settings-page">
      <section class="settings-group" aria-labelledby="preferences-heading">
        <header class="group-heading">
          <h3 id="preferences-heading">{{ t("settings.appearance.preferences") }}</h3>
          <p>{{ t("settings.appearance.preferencesDescription") }}</p>
        </header>
        <div class="group-surface">
          <div class="setting-row compact-row">
            <div class="setting-copy"><strong>{{ t("common.language.label") }}</strong><p>{{ t("settings.appearance.languageDescription") }}</p></div>
            <div class="language-select row-control">
              <ControlPlaneSelect :model-value="preference" @update:model-value="updateLocalePreference">
                <ControlPlaneSelectItem value="system">{{ t("common.language.system") }}</ControlPlaneSelectItem>
                <ControlPlaneSelectItem value="en-US">{{ t("common.language.enUS") }}</ControlPlaneSelectItem>
                <ControlPlaneSelectItem value="zh-CN">{{ t("common.language.zhCN") }}</ControlPlaneSelectItem>
              </ControlPlaneSelect>
            </div>
          </div>
          <div class="setting-row compact-row">
            <div class="setting-copy"><strong>{{ t("settings.appearance.theme") }}</strong><p>{{ t("settings.appearance.themeDescription") }}</p></div>
            <div class="theme-choice-group row-control" :aria-label="t('settings.appearance.colorTheme')">
              <Button variant="outline" :class="{ active: themePreference === 'light' }" :aria-pressed="themePreference === 'light'" @click="emit('update:themePreference', 'light')"><Sun :size="16" /><span>{{ t("settings.appearance.light") }}</span></Button>
              <Button variant="outline" :class="{ active: themePreference === 'dark' }" :aria-pressed="themePreference === 'dark'" @click="emit('update:themePreference', 'dark')"><Moon :size="16" /><span>{{ t("settings.appearance.dark") }}</span></Button>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-group" aria-labelledby="access-heading">
        <header class="group-heading">
          <h3 id="access-heading">{{ t("settings.appearance.accessAndInput") }}</h3>
          <p>{{ t("settings.appearance.accessAndInputDescription") }}</p>
        </header>
        <div class="group-surface">
          <div class="setting-row">
            <div class="setting-copy"><strong>{{ t("settings.publicAccess.title") }}</strong><p>{{ t("settings.publicAccess.description") }}</p></div>
            <div class="setting-form">
              <label>
                <span>{{ t("settings.publicAccess.field") }}</span>
                <!-- i18n-audit-allow-next-line code-token: example control-plane URL -->
                <ControlPlaneInput :model-value="publicBaseUrl" placeholder="https://control.example.com" @update:model-value="emit('update:publicBaseUrl', $event)" />
              </label>
              <div class="row-actions"><Button variant="outline" size="sm" @click="emit('detectPublicBaseUrl')">{{ t("settings.publicAccess.useCurrent") }}</Button><Button size="sm" :disabled="savingPublicBaseUrl" @click="emit('savePublicBaseUrl')">{{ t("common.actions.save") }}</Button></div>
              <p v-if="publicBaseUrlMessage" class="settings-success" role="status">{{ publicBaseUrlMessage }}</p>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-copy"><strong>{{ t("settings.composer.title") }}</strong><p>{{ t("settings.composer.description") }}</p></div>
            <div class="setting-form">
              <div class="composer-fields">
                <label><span>{{ t("settings.composer.commandTrigger") }}</span><ControlPlaneInput :model-value="commandTrigger" :aria-label="t('settings.composer.commandTriggerAria')" @update:model-value="emit('update:commandTrigger', $event)" /><small v-if="commandTriggerError" class="settings-error">{{ commandTriggerError }}</small></label>
                <label><span>{{ t("settings.composer.mentionTrigger") }}</span><ControlPlaneInput :model-value="mentionTrigger" :aria-label="t('settings.composer.mentionTriggerAria')" @update:model-value="emit('update:mentionTrigger', $event)" /><small v-if="mentionTriggerError" class="settings-error">{{ mentionTriggerError }}</small></label>
              </div>
              <div class="row-actions"><Button variant="outline" size="sm" :disabled="savingTriggerSettings || triggerSettingsAtDefaults" @click="emit('resetTriggers')">{{ t("settings.composer.reset") }}</Button><Button size="sm" :disabled="savingTriggerSettings || !triggerSettingsDirty || Boolean(commandTriggerError || mentionTriggerError)" @click="emit('saveTriggers')">{{ t("common.actions.save") }}</Button></div>
              <p v-if="triggerSettingsMessage" :class="triggerSettingsMessageError ? 'settings-error' : 'settings-success'" role="status">{{ triggerSettingsMessage }}</p>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-group" aria-labelledby="maintenance-heading">
        <header class="group-heading">
          <h3 id="maintenance-heading">{{ t("settings.appearance.maintenance") }}</h3>
          <p>{{ t("settings.appearance.maintenanceDescription") }}</p>
        </header>
        <div class="group-surface">
          <div class="setting-row">
            <div class="setting-copy"><strong>{{ desktopUpdatesAvailable ? t("settings.appearance.desktopUpdates") : t("settings.appearance.serverUpdates") }}</strong><p>{{ desktopUpdatesAvailable ? t("settings.appearance.desktopProduct") : t("settings.appearance.serverProduct") }}</p></div>
            <div v-if="desktopUpdatesAvailable" class="maintenance-control">
              <div class="update-toolbar"><code>{{ desktopUpdateSummary }}</code><div class="update-channel-select"><ControlPlaneSelect :model-value="desktopUpdateState?.channel || 'stable'" :disabled="desktopUpdateBusy" @update:model-value="emit('update:desktopUpdateChannel', $event)"><ControlPlaneSelectItem value="stable">{{ t("settings.appearance.stable") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="beta">{{ t("settings.appearance.beta") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="alpha">{{ t("settings.appearance.alpha") }}</ControlPlaneSelectItem></ControlPlaneSelect></div></div>
              <div v-if="desktopUpdateReason" class="inline-notice" role="status"><AlertTriangle :size="15" aria-hidden="true" /><span>{{ desktopUpdateReason }}</span></div>
              <small v-if="desktopUpdateState?.error" class="settings-error">{{ desktopUpdateState.error.message }}</small>
              <div class="row-actions"><Button v-if="desktopUpdateState?.capabilities.check" variant="outline" size="sm" :disabled="desktopUpdateCheckDisabled" @click="emit('checkDesktopUpdate')"><RefreshCw :size="14" /><span>{{ desktopUpdateState?.phase === 'checking' ? t("settings.appearance.checking") : t("settings.appearance.check") }}</span></Button><Button v-if="desktopUpdateState?.phase === 'available' && desktopUpdateState.capabilities.download" size="sm" @click="emit('downloadDesktopUpdate')"><Download :size="14" /><span>{{ t("settings.appearance.download") }}</span></Button><Button v-if="desktopUpdateState?.phase === 'downloaded' && desktopUpdateState.capabilities.install" size="sm" @click="emit('installDesktopUpdate')"><RotateCw :size="14" /><span>{{ t("settings.appearance.restartInstall") }}</span></Button><Button v-if="showDesktopReleaseButton" variant="outline" size="sm" @click="emit('openDesktopRelease')"><ExternalLink :size="14" /><span>{{ t("settings.appearance.openRelease") }}</span></Button></div>
              <div v-if="desktopUpdateState?.phase === 'downloading'" class="desktop-update-progress" role="progressbar" :aria-valuenow="desktopUpdatePercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${desktopUpdatePercent}%` }"></span><code>{{ desktopUpdatePercent }}%</code></div><p v-if="desktopUpdateState?.releaseName" class="setting-note">{{ desktopUpdateState.releaseName }}</p>
            </div>
            <div v-else class="maintenance-control">
              <div class="update-toolbar">
                <code v-if="serverUpdateCheck?.reason && !serverUpdateCheck.updateAvailable">{{ serverUpdateCheck.reason }}</code><code v-else-if="serverUpdateCheck">{{ serverUpdateCheck.currentVersion || serverCurrentVersion || t("settings.appearance.unknown") }} → {{ serverUpdateCheck.availableVersion }} · {{ serverUpdateCheck.updateAvailable ? t("settings.appearance.updateAvailable") : t("settings.appearance.upToDate") }}</code><code v-else>{{ serverUpdatesAvailable ? t("settings.appearance.currentNotChecked", { version: serverCurrentVersion || t("settings.appearance.unknown") }) : serverUnavailableReason }}</code>
                <div class="update-channel-select"><ControlPlaneSelect :model-value="serverUpdateChannel" :disabled="!serverUpdatesAvailable" @update:model-value="emit('update:serverUpdateChannel', $event)"><ControlPlaneSelectItem value="stable">{{ t("settings.appearance.stable") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="beta">{{ t("settings.appearance.beta") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="alpha">{{ t("settings.appearance.alpha") }}</ControlPlaneSelectItem></ControlPlaneSelect></div>
              </div>
              <div class="row-actions"><Button variant="outline" size="sm" :disabled="!serverUpdatesAvailable || checkingServerUpdate" @click="emit('checkServerUpdate')"><RefreshCw :size="14" /><span>{{ checkingServerUpdate ? t("settings.appearance.checking") : t("settings.appearance.check") }}</span></Button><Button size="sm" :disabled="!serverUpdateCheck?.supported || !serverUpdateCheck.updateAvailable || !serverUpdateCheck.preflightToken || applyingServerUpdate" @click="emit('applyServerUpdate')"><Download :size="14" /><span>{{ applyingServerUpdate ? t("settings.appearance.queuing") : t("settings.appearance.update") }}</span></Button></div>
              <p v-if="serverUpdateCheck" class="setting-note">{{ t("settings.nodeDetail.updateImpact", { restarting: serverUpdateCheck.impact.restartInstanceCount, active: serverUpdateCheck.impact.activeInstanceCount, stopped: serverUpdateCheck.impact.stoppedInstanceCount }) }}</p>
              <div v-if="serverUpdateJob" class="server-update-job"><span>{{ t("settings.appearance.latestJob") }}</span><code>{{ serverUpdateJob.fromVersion || t("settings.appearance.unknown") }} → {{ serverUpdateJob.toVersion }}</code><Badge :variant="serverUpdateJob.status === 'succeeded' ? 'default' : 'secondary'">{{ translateStatus(updateJobStatusKeys, serverUpdateJob.status, t) }}</Badge></div>
              <p v-if="serverUpdateJob" class="setting-note">{{ t("settings.nodeDetail.rolloutProgress", { matched: serverUpdateJob.rollout.matchedInstanceCount, expected: serverUpdateJob.rollout.expectedInstanceCount, failed: serverUpdateJob.rollout.failedInstanceCount, deferred: serverUpdateJob.rollout.deferredInstanceCount }) }}<span v-if="serverUpdateJob.error"> · {{ serverUpdateJob.error.message }}</span></p>
            </div>
          </div>
          <div class="setting-row diagnostic-row">
            <div class="setting-copy"><strong>{{ t("settings.diagnosticLogs.title") }}</strong><p>{{ t("settings.diagnosticLogs.description") }}</p></div>
            <div class="diagnostic-control">
              <label class="diagnostic-toggle"><Checkbox :model-value="diagnosticLogs" :disabled="savingDiagnosticLogs" @update:model-value="emit('update:diagnosticLogs', $event === true)" /><span>{{ diagnosticLogs ? t("settings.diagnosticLogs.enabled") : t("settings.diagnosticLogs.disabled") }}</span></label>
              <div class="privacy-note"><AlertTriangle :size="15" aria-hidden="true" /><span>{{ t("settings.diagnosticLogs.sensitive") }}</span></div>
              <div class="row-actions"><Button variant="outline" size="sm" :disabled="exportingDiagnosticLogs" @click="emit('exportDiagnosticLogs')"><Archive :size="14" /><span>{{ exportingDiagnosticLogs ? t("settings.diagnosticLogs.exporting") : t("settings.diagnosticLogs.export") }}</span></Button></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Archive, Download, ExternalLink, Moon, RefreshCw, RotateCw, Sun } from "@lucide/vue";
import type { UpdateChannel, UpdateCheckResult, UpdateJob } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import type { ThemePreference } from "../../../utils/theme";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { useControlPlaneLocale, type LocalePreference } from "../../../i18n/index.ts";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { DesktopUpdateState } from "./useDesktopUpdates";
import { translateStatus, updateJobStatusKeys } from "../../../i18n/status.ts";

const props = defineProps<{ publicBaseUrl: string; publicBaseUrlMessage?: string; mentionTrigger: string; commandTrigger: string; commandTriggerError?: string; mentionTriggerError?: string; savingTriggerSettings?: boolean; triggerSettingsAtDefaults: boolean; triggerSettingsDirty: boolean; triggerSettingsMessage?: string; triggerSettingsMessageError?: boolean; savingPublicBaseUrl?: boolean; serverUpdatesAvailable: boolean; serverUnavailableReason: string; serverCurrentVersion?: string; serverUpdateChannel: UpdateChannel; serverUpdateCheck?: UpdateCheckResult; serverUpdateJob?: UpdateJob; checkingServerUpdate: boolean; applyingServerUpdate: boolean; desktopUpdatesAvailable: boolean; desktopUpdateState?: DesktopUpdateState; themePreference: ThemePreference; diagnosticLogs: boolean; savingDiagnosticLogs: boolean; exportingDiagnosticLogs: boolean }>();
const { t } = useI18n();
const { preference, setPreference } = useControlPlaneLocale();
function updateLocalePreference(value: string) { if (value === "system" || value === "en-US" || value === "zh-CN") setPreference(value satisfies LocalePreference); }
const emit = defineEmits<{ detectPublicBaseUrl: []; checkServerUpdate: []; applyServerUpdate: []; checkDesktopUpdate: []; downloadDesktopUpdate: []; installDesktopUpdate: []; openDesktopRelease: []; savePublicBaseUrl: []; resetTriggers: []; saveTriggers: []; "update:commandTrigger": [value: string]; "update:mentionTrigger": [value: string]; "update:publicBaseUrl": [value: string]; "update:serverUpdateChannel": [value: string]; "update:desktopUpdateChannel": [value: string]; "update:themePreference": [theme: ThemePreference]; "update:diagnosticLogs": [enabled: boolean]; exportDiagnosticLogs: [] }>();
const desktopUpdateBusy = computed(() => ["checking", "downloading", "installing"].includes(props.desktopUpdateState?.phase || ""));
const desktopUpdateCheckDisabled = computed(() => !props.desktopUpdateState?.capabilities.check || desktopUpdateBusy.value || props.desktopUpdateState?.phase === "downloaded");
const desktopUpdatePercent = computed(() => Math.max(0, Math.min(100, Math.round(props.desktopUpdateState?.progress?.percent || 0))));
const desktopUpdateReasonCodes = new Set(["development-build", "windows-signing-required", "appimage-required", "unsupported-platform"]);
const desktopUpdateReason = computed(() => {
  const reasonCode = props.desktopUpdateState?.capabilities.reasonCode;
  if (!reasonCode || !desktopUpdateReasonCodes.has(reasonCode)) {
    return props.desktopUpdateState?.capabilities.reason || reasonCode ? t("settings.appearance.updateUnavailable") : "";
  }
  return t(`settings.appearance.updateReason.${reasonCode}`);
});
const showDesktopReleaseButton = computed(() => Boolean(props.desktopUpdateState && (!props.desktopUpdateState.capabilities.check || (props.desktopUpdateState.phase === "available" && !props.desktopUpdateState.capabilities.download) || props.desktopUpdateState.phase === "error")));
const desktopUpdateSummary = computed(() => { const state = props.desktopUpdateState; if (!state) return t("settings.appearance.loadingUpdateState"); if (state.phase === "available") return `${state.currentVersion} → ${state.availableVersion || t("settings.appearance.unknown")} · ${t("settings.appearance.updateAvailable")}`; if (state.phase === "downloaded") return t("settings.appearance.downloadedRestart", { version: state.availableVersion || t("settings.appearance.update") }); if (state.phase === "downloading") return t("settings.appearance.versionDownloading", { current: state.currentVersion, available: state.availableVersion || t("settings.appearance.update") }); if (state.phase === "checking") return t("settings.appearance.currentChecking", { version: state.currentVersion }); if (state.phase === "up-to-date") return `${state.currentVersion} · ${t("settings.appearance.upToDate")}`; if (state.phase === "installing") return t("settings.appearance.preparingRestart", { version: state.availableVersion || t("settings.appearance.update") }); return state.phase === "unsupported" ? t("settings.appearance.currentManual", { version: state.currentVersion }) : t("settings.appearance.currentNotChecked", { version: state.currentVersion }); });
</script>

<style scoped>
.basic-settings-scroll { height: 100%; min-height: 0; width: 100%; }
.basic-settings-scroll :deep([data-reka-scroll-area-viewport] > div) { min-height: 100%; }
.basic-settings-page { display: grid; gap: 18px; margin: 0 auto; padding: 0 10px 20px 0; width: min(100%, 1080px); }
.group-heading, .setting-copy, .setting-form, .maintenance-control { display: grid; }
.group-heading h3, .group-heading p, .setting-copy p, .setting-note { margin: 0; }
.group-heading p, .setting-copy p, .setting-note { color: var(--text-muted); font-size: 13px; line-height: 1.5; }
.settings-group { display: grid; gap: 7px; }
.group-heading { gap: 2px; padding: 0 2px; }
.group-heading h3 { color: var(--text-strong); font-size: 14px; font-weight: 600; }
.group-surface { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.setting-row { align-items: start; display: grid; gap: 20px; grid-template-columns: minmax(220px,.8fr) minmax(320px,1.2fr); padding: 14px 16px; }
.setting-row + .setting-row { border-top: 1px solid var(--line); }
.compact-row { align-items: center; }
.setting-copy { gap: 3px; min-width: 0; }
.setting-copy strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.setting-copy small, .setting-note { color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.row-control { justify-self: end; }
.language-select, .update-channel-select { width: 180px; }
.theme-choice-group, .row-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.theme-choice-group :deep(button.active) { background: var(--surface-active); border-color: var(--accent); color: var(--text-strong); }
.setting-form, .maintenance-control { gap: 8px; min-width: 0; }
.setting-form label, .composer-fields label { display: grid; gap: 5px; }
.setting-form label > span { color: var(--text-muted); font-size: 12px; }
.composer-fields { display: grid; gap: 8px; grid-template-columns: repeat(2,minmax(120px,1fr)); }
.row-actions { align-items: center; justify-content: flex-end; }
.update-toolbar { align-items: center; display: grid; gap: 10px; grid-template-columns: minmax(0,1fr) 180px; }
.update-toolbar > code, .server-update-job code { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inline-notice, .privacy-note { align-items: flex-start; background: var(--surface-inset); border: 1px solid var(--line); border-radius: 7px; color: var(--text-muted); display: flex; font-size: 12px; gap: 7px; line-height: 1.4; padding: 7px 9px; }
.inline-notice svg, .privacy-note svg { flex: 0 0 auto; margin-top: 1px; }
.server-update-job { align-items: center; border-top: 1px solid var(--line); display: grid; gap: 7px; grid-template-columns: auto minmax(0,1fr) auto; padding-top: 8px; }
.server-update-job > span { color: var(--text-muted); font-size: 12px; }
.desktop-update-progress { background: var(--surface-muted); border: 1px solid var(--line); border-radius: 999px; height: 20px; overflow: hidden; position: relative; }
.desktop-update-progress > span { background: var(--accent); display: block; height: 100%; transition: width 180ms ease; }
.desktop-update-progress > code { color: var(--text-strong); display: grid; font-size: 12px; inset: 0; place-items: center; position: absolute; }
.diagnostic-control { display: grid; gap: 8px; min-width: 0; }
.diagnostic-toggle { align-items: center; color: var(--text-strong); cursor: pointer; display: flex; font-size: 13px; font-weight: 500; gap: 10px; min-height: 28px; }
.settings-success, .settings-error { font-size: 12px; margin: 0; }
@media (max-width: 760px) { .basic-settings-page { gap: 16px; padding-right: 8px; } .setting-row { gap: 10px; grid-template-columns: 1fr; padding: 13px 14px; } .row-control { justify-self: stretch; } .language-select, .update-channel-select { width: 100%; } .update-toolbar { grid-template-columns: 1fr; } .row-actions { justify-content: flex-start; } }
@media (max-width: 520px) { .composer-fields, .server-update-job { grid-template-columns: 1fr; } }
</style>
