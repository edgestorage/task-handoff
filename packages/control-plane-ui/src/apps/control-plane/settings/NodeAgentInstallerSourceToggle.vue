<template>
  <div class="node-agent-installer-source">
    <span class="node-agent-installer-source-label">{{ t("settings.nodeDialogs.installerSource") }}</span>
    <ToggleGroup
      type="single"
      :model-value="modelValue"
      :aria-label="t('settings.nodeDialogs.installerSource')"
      class="node-agent-installer-source-switch"
      @update:model-value="updateSource"
    >
      <ToggleGroupItem value="github" size="sm">
        <FileCode2 :size="13" aria-hidden="true" />
        <span>{{ t("settings.nodeDialogs.installerSourceGitHub") }}</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="control-plane" size="sm">
        <ServerCog :size="13" aria-hidden="true" />
        <span>{{ t("settings.nodeDialogs.installerSourceControlPlane") }}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  </div>
</template>

<script setup lang="ts">
import { FileCode2, ServerCog } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { isNodeAgentInstallerSource, type NodeAgentInstallerSource } from "@task-handoff/protocol/control-plane";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";

defineProps<{ modelValue: NodeAgentInstallerSource }>();
const emit = defineEmits<{ "update:modelValue": [value: NodeAgentInstallerSource] }>();
const { t } = useI18n();

function updateSource(value: unknown) {
  if (isNodeAgentInstallerSource(value)) emit("update:modelValue", value);
}
</script>

<style scoped>
.node-agent-installer-source {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  justify-content: flex-start;
}

.node-agent-installer-source-label {
  flex: 0 0 auto;
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
}

.node-agent-installer-source-switch {
  display: inline-flex;
  width: fit-content;
  height: 32px;
  min-height: 32px;
  align-items: center;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-active);
  padding: 2px;
}

.node-agent-installer-source-switch :deep(button) {
  min-width: 82px;
  height: 26px;
  min-height: 26px;
  gap: 5px;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  padding: 0 10px;
}

.node-agent-installer-source-switch :deep(button:hover),
.node-agent-installer-source-switch :deep(button:focus-visible) {
  background: transparent;
  color: var(--text-strong);
}

.node-agent-installer-source-switch :deep(button:focus-visible) {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.node-agent-installer-source-switch :deep(button[data-state="on"]) {
  background: var(--surface-raised);
  box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
  color: var(--text-strong);
}

.node-agent-installer-source-switch :deep(button svg) {
  flex: 0 0 auto;
  opacity: 0.82;
}

.node-agent-installer-source-switch :deep(button[data-state="on"] svg) {
  opacity: 1;
}

@media (max-width: 520px) {
  .node-agent-installer-source {
    align-items: flex-start;
    flex-direction: column;
  }

  .node-agent-installer-source-switch {
    width: 100%;
  }

  .node-agent-installer-source-switch :deep(button) {
    flex: 1;
    min-width: 0;
  }
}
</style>
