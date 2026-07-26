<template>
  <Dialog :open="open" @update:open="(nextOpen) => !nextOpen && emit('close')">
    <DialogContent class="node-agent-install-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("settings.nodeDialogs.installTitle") }}</DialogTitle>
        <DialogDescription>
          {{ t("settings.nodeDialogs.installDescription") }}
        </DialogDescription>
      </DialogHeader>

      <div class="node-agent-install-steps">
        <section class="node-agent-install-step">
          <span class="node-agent-install-step-number">1</span>
          <div>
            <strong>{{ t("settings.nodeDialogs.checkHost") }}</strong>
            <p>{{ t("settings.nodeDialogs.requirements") }}</p>
          </div>
        </section>

        <section class="node-agent-install-step">
          <span class="node-agent-install-step-number">2</span>
          <div class="node-agent-install-step-content">
            <label for="node-agent-install-base-url">{{ t("settings.nodeDialogs.publicUrl") }}</label>
            <!-- i18n-audit-allow-next-line code-token: example control-plane URL -->
            <ControlPlaneInput id="node-agent-install-base-url" v-model="controlPlaneUrl" placeholder="https://control-plane.example.com" />
            <p>{{ t("settings.nodeDialogs.reachableUrl") }}</p>
          </div>
        </section>

        <section class="node-agent-install-step">
          <span class="node-agent-install-step-number">3</span>
          <div class="node-agent-install-step-content">
            <div class="node-agent-install-command-head">
              <strong>{{ t("settings.nodeDialogs.runCommand") }}</strong>
              <Button size="sm" :disabled="!installCommand" @click="copyCommand">
                <Check v-if="copied" :size="15" />
                <Copy v-else :size="15" />
                <span>{{ copied ? t("settings.nodeDialogs.copied") : t("settings.nodeDialogs.copyCommand") }}</span>
              </Button>
            </div>
            <pre :class="{ empty: !installCommand }"><code>{{ installCommand || t("settings.nodeDialogs.enterUrl") }}</code></pre>
            <p>{{ t("settings.nodeDialogs.expiresHint", { time: formattedExpiry }) }}</p>
          </div>
        </section>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">{{ t("settings.nodeDialogs.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { nodeAgentInstallCommand } from "./nodeAgentInstallCommand";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";

const { t } = useI18n();
const { locale } = useControlPlaneLocale();

const props = defineProps<{
  expiresAt: string;
  initialControlPlaneUrl: string;
  joinToken: string;
  open: boolean;
  version?: string;
}>();

const emit = defineEmits<{ close: [] }>();
const controlPlaneUrl = ref(props.initialControlPlaneUrl);
const copied = ref(false);
const installCommand = computed(() => nodeAgentInstallCommand({
  controlPlaneUrl: controlPlaneUrl.value,
  joinToken: props.joinToken,
  version: props.version,
}));
const formattedExpiry = computed(() => {
  const expiresAt = new Date(props.expiresAt);
  return Number.isNaN(expiresAt.getTime()) ? props.expiresAt : formatDateTime(expiresAt, locale.value);
});

watch(() => [props.joinToken, props.initialControlPlaneUrl], () => {
  controlPlaneUrl.value = props.initialControlPlaneUrl;
  copied.value = false;
});

watch(controlPlaneUrl, () => {
  copied.value = false;
});

async function copyCommand() {
  try {
    if (!installCommand.value || !navigator.clipboard?.writeText) throw new Error(t("settings.nodeDialogs.clipboardUnavailable"));
    await navigator.clipboard.writeText(installCommand.value);
    copied.value = true;
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : t("settings.nodeDialogs.copyCommandFailed"));
  }
}
</script>

<style scoped>
.node-agent-install-dialog {
  width: min(720px, calc(100vw - 36px));
  max-height: calc(100vh - 36px);
  overflow-y: auto;
}

.node-agent-install-steps {
  display: grid;
  gap: 12px;
}

.node-agent-install-step {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-inset);
}

.node-agent-install-step-number {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 999px;
  background: hsl(var(--accent));
  color: hsl(var(--accent-foreground));
  font-size: 12px;
  font-weight: 800;
}

.node-agent-install-step-content {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.node-agent-install-step strong,
.node-agent-install-step label {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 750;
}

.node-agent-install-step p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.node-agent-install-command-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.node-agent-install-command-head button {
  flex: 0 0 auto;
}

.node-agent-install-step pre {
  max-height: 210px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.node-agent-install-step pre.empty {
  color: var(--text-muted);
}

@media (max-width: 560px) {
  .node-agent-install-command-head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
