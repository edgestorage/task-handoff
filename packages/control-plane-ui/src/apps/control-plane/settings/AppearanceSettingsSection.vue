<template>
  <div class="basic-settings-grid">
    <section v-if="desktopUpdatesAvailable" class="modal-section basic-panel server-update-panel desktop-update-panel">
      <div class="section-head">
        <span>Desktop updates</span>
        <div class="update-channel-select">
          <ControlPlaneSelect :model-value="desktopUpdateState?.channel || 'stable'" :disabled="desktopUpdateBusy" @update:model-value="emit('update:desktopUpdateChannel', $event)">
            <ControlPlaneSelectItem value="stable">Stable</ControlPlaneSelectItem>
            <ControlPlaneSelectItem value="beta">Beta</ControlPlaneSelectItem>
            <ControlPlaneSelectItem value="alpha">Alpha</ControlPlaneSelectItem>
          </ControlPlaneSelect>
        </div>
      </div>
      <div class="server-update-state">
        <div>
          <strong>TaskHandoff desktop</strong>
          <code v-if="!desktopUpdateState">Loading update state</code>
          <code v-else>{{ desktopUpdateSummary }}</code>
          <small v-if="desktopUpdateState?.capabilities.reason" class="desktop-update-reason">{{ desktopUpdateState.capabilities.reason }}</small>
          <small v-if="desktopUpdateState?.error" class="settings-error">{{ desktopUpdateState.error.message }}</small>
        </div>
        <div class="server-update-actions">
          <Button variant="outline" size="sm" :disabled="desktopUpdateCheckDisabled" @click="emit('checkDesktopUpdate')">
            <RefreshCw :size="14" />
            <span>{{ desktopUpdateState?.phase === 'checking' ? "Checking" : "Check" }}</span>
          </Button>
          <Button v-if="desktopUpdateState?.phase === 'available' && desktopUpdateState.capabilities.download" variant="outline" size="sm" @click="emit('downloadDesktopUpdate')">
            <Download :size="14" />
            <span>Download</span>
          </Button>
          <Button v-if="desktopUpdateState?.phase === 'downloaded' && desktopUpdateState.capabilities.install" variant="outline" size="sm" @click="emit('installDesktopUpdate')">
            <RotateCw :size="14" />
            <span>Restart and install</span>
          </Button>
          <Button v-if="showDesktopReleaseButton" variant="outline" size="sm" @click="emit('openDesktopRelease')">
            <ExternalLink :size="14" />
            <span>Open release</span>
          </Button>
        </div>
      </div>
      <div v-if="desktopUpdateState?.phase === 'downloading'" class="desktop-update-progress" role="progressbar" :aria-valuenow="desktopUpdatePercent" aria-valuemin="0" aria-valuemax="100">
        <span :style="{ width: `${desktopUpdatePercent}%` }"></span>
        <code>{{ desktopUpdatePercent }}%</code>
      </div>
      <p v-if="desktopUpdateState?.releaseName" class="section-description">{{ desktopUpdateState.releaseName }}</p>
    </section>
    <section v-else class="modal-section basic-panel server-update-panel">
      <div class="section-head">
        <span>Server updates</span>
        <div class="update-channel-select">
          <ControlPlaneSelect :model-value="serverUpdateChannel" :disabled="!serverUpdatesAvailable" @update:model-value="emit('update:serverUpdateChannel', $event)">
            <ControlPlaneSelectItem value="stable">Stable</ControlPlaneSelectItem>
            <ControlPlaneSelectItem value="beta">Beta</ControlPlaneSelectItem>
            <ControlPlaneSelectItem value="alpha">Alpha</ControlPlaneSelectItem>
          </ControlPlaneSelect>
        </div>
      </div>
      <div class="server-update-state">
        <div>
          <strong>TaskHandoff server</strong>
          <code v-if="serverUpdateCheck?.reason && !serverUpdateCheck.updateAvailable">{{ serverUpdateCheck.reason }}</code>
          <code v-else-if="serverUpdateCheck">
            {{ serverUpdateCheck.currentVersion || serverCurrentVersion || "unknown" }} → {{ serverUpdateCheck.availableVersion }} · {{ serverUpdateCheck.updateAvailable ? "update available" : "up to date" }}
          </code>
          <code v-else>{{ serverUpdatesAvailable ? `Current ${serverCurrentVersion || "unknown"} · not checked` : serverUnavailableReason }}</code>
        </div>
        <div class="server-update-actions">
          <Button variant="outline" size="sm" :disabled="!serverUpdatesAvailable || checkingServerUpdate" @click="emit('checkServerUpdate')">
            <RefreshCw :size="14" />
            <span>{{ checkingServerUpdate ? "Checking" : "Check" }}</span>
          </Button>
          <Button variant="outline" size="sm" :disabled="!serverUpdateCheck?.supported || !serverUpdateCheck.updateAvailable || applyingServerUpdate" @click="emit('applyServerUpdate')">
            <Download :size="14" />
            <span>{{ applyingServerUpdate ? "Queuing" : "Update" }}</span>
          </Button>
        </div>
      </div>
      <div v-if="serverUpdateJob" class="server-update-job">
        <span>Latest job</span>
        <code>{{ serverUpdateJob.fromVersion || "unknown" }} → {{ serverUpdateJob.toVersion }}</code>
        <Badge :variant="serverUpdateJob.status === 'succeeded' ? 'default' : 'secondary'">{{ serverUpdateJob.status }}</Badge>
      </div>
    </section>
    <section class="modal-section appearance-panel">
      <div class="section-head">
        <span>Theme</span>
      </div>
      <p class="section-description">Choose the color scheme used throughout the control plane.</p>
      <div class="theme-choice-group" aria-label="Color theme">
        <Button variant="outline" :class="{ active: themePreference === 'light' }" :aria-pressed="themePreference === 'light'" @click="emit('update:themePreference', 'light')">
          <Sun :size="16" />
          <span>Light</span>
        </Button>
        <Button variant="outline" :class="{ active: themePreference === 'dark' }" :aria-pressed="themePreference === 'dark'" @click="emit('update:themePreference', 'dark')">
          <Moon :size="16" />
          <span>Dark</span>
        </Button>
      </div>
    </section>
    <section class="modal-section appearance-panel">
      <div class="section-head">
        <span>Public access URL</span>
      </div>
      <p class="section-description">Set the external address used to open control plane sessions from chat.</p>
      <div class="public-url-form">
        <label>
          <span>Control Plane URL</span>
          <ControlPlaneInput :model-value="publicBaseUrl" placeholder="https://control.example.com" @update:model-value="emit('update:publicBaseUrl', $event)" />
        </label>
        <div class="public-url-actions">
          <Button variant="outline" size="sm" @click="emit('detectPublicBaseUrl')">Use current URL</Button>
          <Button variant="outline" size="sm" :disabled="savingPublicBaseUrl" @click="emit('savePublicBaseUrl')">{{ savingPublicBaseUrl ? "Saving" : "Save" }}</Button>
        </div>
        <p v-if="publicBaseUrlMessage" class="settings-success">{{ publicBaseUrlMessage }}</p>
      </div>
    </section>
    <section class="modal-section appearance-panel composer-shortcuts-panel">
      <div class="section-head">
        <span>Composer shortcuts</span>
      </div>
      <p class="section-description">Configure the characters that open commands and context mentions in every AI composer.</p>
      <div class="composer-shortcuts-form">
        <label>
          <span>Command trigger</span>
          <ControlPlaneInput :model-value="commandTrigger" aria-label="Command trigger character" @update:model-value="emit('update:commandTrigger', $event)" />
          <small v-if="commandTriggerError" class="settings-error">{{ commandTriggerError }}</small>
        </label>
        <label>
          <span>Mention trigger</span>
          <ControlPlaneInput :model-value="mentionTrigger" aria-label="Mention trigger character" @update:model-value="emit('update:mentionTrigger', $event)" />
          <small v-if="mentionTriggerError" class="settings-error">{{ mentionTriggerError }}</small>
        </label>
        <div class="public-url-actions composer-shortcuts-actions">
          <Button variant="outline" size="sm" :disabled="savingTriggerSettings || triggerSettingsAtDefaults" @click="emit('resetTriggers')">Reset</Button>
          <Button variant="outline" size="sm" :disabled="savingTriggerSettings || !triggerSettingsDirty || Boolean(commandTriggerError || mentionTriggerError)" @click="emit('saveTriggers')">{{ savingTriggerSettings ? "Saving" : "Save" }}</Button>
        </div>
        <p v-if="triggerSettingsMessage" :class="triggerSettingsMessageError ? 'settings-error' : 'settings-success'">{{ triggerSettingsMessage }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Download, ExternalLink, Moon, RefreshCw, RotateCw, Sun } from "@lucide/vue";
import type { UpdateChannel, UpdateCheckResult, UpdateJob } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import type { ThemePreference } from "../../../utils/theme";
import { Button } from "../../../components/ui/button";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { DesktopUpdateState } from "./useDesktopUpdates";

const props = defineProps<{
  publicBaseUrl: string;
  publicBaseUrlMessage?: string;
  mentionTrigger: string;
  commandTrigger: string;
  commandTriggerError?: string;
  mentionTriggerError?: string;
  savingTriggerSettings?: boolean;
  triggerSettingsAtDefaults: boolean;
  triggerSettingsDirty: boolean;
  triggerSettingsMessage?: string;
  triggerSettingsMessageError?: boolean;
  savingPublicBaseUrl?: boolean;
  serverUpdatesAvailable: boolean;
  serverUnavailableReason: string;
  serverCurrentVersion?: string;
  serverUpdateChannel: UpdateChannel;
  serverUpdateCheck?: UpdateCheckResult;
  serverUpdateJob?: UpdateJob;
  checkingServerUpdate: boolean;
  applyingServerUpdate: boolean;
  desktopUpdatesAvailable: boolean;
  desktopUpdateState?: DesktopUpdateState;
  themePreference: ThemePreference;
}>();

const emit = defineEmits<{
  detectPublicBaseUrl: [];
  checkServerUpdate: [];
  applyServerUpdate: [];
  checkDesktopUpdate: [];
  downloadDesktopUpdate: [];
  installDesktopUpdate: [];
  openDesktopRelease: [];
  savePublicBaseUrl: [];
  resetTriggers: [];
  saveTriggers: [];
  "update:commandTrigger": [value: string];
  "update:mentionTrigger": [value: string];
  "update:publicBaseUrl": [value: string];
  "update:serverUpdateChannel": [value: string];
  "update:desktopUpdateChannel": [value: string];
  "update:themePreference": [theme: ThemePreference];
}>();

const desktopUpdateBusy = computed(() => ["checking", "downloading", "installing"].includes(props.desktopUpdateState?.phase || ""));
const desktopUpdateCheckDisabled = computed(() => !props.desktopUpdateState?.capabilities.check
  || desktopUpdateBusy.value
  || props.desktopUpdateState?.phase === "downloaded");
const desktopUpdatePercent = computed(() => Math.max(0, Math.min(100, Math.round(props.desktopUpdateState?.progress?.percent || 0))));
const showDesktopReleaseButton = computed(() => Boolean(
  props.desktopUpdateState
  && (!props.desktopUpdateState.capabilities.check
    || (props.desktopUpdateState.phase === "available" && !props.desktopUpdateState.capabilities.download)
    || props.desktopUpdateState.phase === "error"),
));
const desktopUpdateSummary = computed(() => {
  const state = props.desktopUpdateState;
  if (!state) return "Loading update state";
  if (state.phase === "available") return `${state.currentVersion} → ${state.availableVersion || "unknown"} · update available`;
  if (state.phase === "downloaded") return `${state.availableVersion || "Update"} downloaded · restart required`;
  if (state.phase === "downloading") return `${state.currentVersion} → ${state.availableVersion || "update"} · downloading`;
  if (state.phase === "checking") return `Current ${state.currentVersion} · checking for updates`;
  if (state.phase === "up-to-date") return `Current ${state.currentVersion} · up to date`;
  if (state.phase === "installing") return `${state.availableVersion || "Update"} · preparing to restart`;
  return `Current ${state.currentVersion} · ${state.phase === "unsupported" ? "manual updates only" : "not checked"}`;
});
</script>

<style scoped>
.basic-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(280px, 1fr));
  align-items: start;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.server-update-panel {
  grid-column: 1 / -1;
}

.update-channel-select {
  width: 150px;
}

.server-update-state {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.server-update-state > div:first-child {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.server-update-state strong {
  color: var(--text-strong);
  font-size: 13px;
}

.server-update-state code,
.server-update-job code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.server-update-job {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.desktop-update-reason {
  color: var(--text-muted);
  font-size: 11px;
}

.desktop-update-progress {
  position: relative;
  overflow: hidden;
  height: 20px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-muted);
}

.desktop-update-progress > span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 180ms ease;
}

.desktop-update-progress > code {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-strong);
  font-size: 10px;
}

.server-update-job > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.appearance-panel {
  align-content: start;
}

.composer-shortcuts-panel {
  grid-column: 1 / -1;
}

.modal-section {
  display: grid;
  gap: 12px;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow:
    var(--shadow-panel),
    inset 0 1px 0 var(--workspace-grid);
  padding: 12px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-head span,
.public-url-form label span,
.composer-shortcuts-form label > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.section-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-description {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  margin: -4px 0 0;
}

.public-url-form,
.composer-shortcuts-form {
  display: grid;
  gap: 10px;
}

.public-url-form label,
.composer-shortcuts-form label {
  display: grid;
  gap: 7px;
}

.composer-shortcuts-form {
  grid-template-columns: repeat(2, minmax(120px, 1fr)) auto;
  align-items: end;
}

.composer-shortcuts-form > p {
  grid-column: 1 / -1;
}

.composer-shortcuts-actions {
  align-self: end;
}

.public-url-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.settings-success {
  font-size: 12px;
  font-weight: 650;
  margin: 0;
}

.settings-error {
  color: var(--status-danger);
  font-size: 12px;
  font-weight: 650;
  margin: 0;
}

.settings-success {
  color: var(--status-success);
}

.theme-choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.theme-choice-group button {
  width: 100%;
  min-height: 42px;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 750;
}

.theme-choice-group button:hover,
.theme-choice-group button:focus-visible,
.theme-choice-group button.active {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
  outline: none;
}

@media (max-width: 780px) {
  .basic-settings-grid {
    grid-template-columns: 1fr;
    overflow: visible;
  }

  .server-update-state {
    grid-template-columns: 1fr;
  }

  .composer-shortcuts-form {
    grid-template-columns: 1fr;
  }

  .composer-shortcuts-form > p {
    grid-column: auto;
  }
}
</style>
