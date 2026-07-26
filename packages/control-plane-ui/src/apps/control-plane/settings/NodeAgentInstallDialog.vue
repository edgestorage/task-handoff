<template>
  <Dialog :open="open" @update:open="(nextOpen) => !nextOpen && emit('close')">
    <DialogContent class="node-agent-install-dialog">
      <DialogHeader>
        <DialogTitle>Install a remote node</DialogTitle>
        <DialogDescription>
          Run the generated command on the remote host. The node-agent will install as a systemd service and connect back to this control plane.
        </DialogDescription>
      </DialogHeader>

      <div class="node-agent-install-steps">
        <section class="node-agent-install-step">
          <span class="node-agent-install-step-number">1</span>
          <div>
            <strong>Check the remote host</strong>
            <p>Requires Linux with systemd, Node.js 24 with npm, and curl. Docker is only required for Docker runtimes.</p>
          </div>
        </section>

        <section class="node-agent-install-step">
          <span class="node-agent-install-step-number">2</span>
          <div class="node-agent-install-step-content">
            <label for="node-agent-install-base-url">Control-plane public URL</label>
            <ControlPlaneInput id="node-agent-install-base-url" v-model="controlPlaneUrl" placeholder="https://control-plane.example.com" />
            <p>The remote host must be able to reach this URL.</p>
          </div>
        </section>

        <section class="node-agent-install-step">
          <span class="node-agent-install-step-number">3</span>
          <div class="node-agent-install-step-content">
            <div class="node-agent-install-command-head">
              <strong>Run the install command</strong>
              <Button size="sm" :disabled="!installCommand" @click="copyCommand">
                <Check v-if="copied" :size="15" />
                <Copy v-else :size="15" />
                <span>{{ copied ? "Copied" : "Copy command" }}</span>
              </Button>
            </div>
            <pre :class="{ empty: !installCommand }"><code>{{ installCommand || "Enter the public URL to generate the command." }}</code></pre>
            <p>This one-time token expires {{ formattedExpiry }}. Generate a new command if it expires.</p>
          </div>
        </section>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">Close</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, Copy } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { nodeAgentInstallCommand } from "./nodeAgentInstallCommand";

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
  return Number.isNaN(expiresAt.getTime()) ? props.expiresAt : expiresAt.toLocaleString();
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
    if (!installCommand.value || !navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
    await navigator.clipboard.writeText(installCommand.value);
    copied.value = true;
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Could not copy the install command.");
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
