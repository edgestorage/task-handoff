<template>
  <Dialog :open="Boolean(token)" @update:open="(open) => !open && emit('close')">
    <DialogContent class="generated-token-dialog">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>
          This token is shown only once. Copy it before closing this dialog.
        </DialogDescription>
      </DialogHeader>

      <div class="generated-token-field">
        <code>{{ token }}</code>
        <Button size="sm" @click="copyToken">
          <Check v-if="copied" :size="15" />
          <Copy v-else :size="15" />
          <span>{{ copied ? "Copied" : "Copy token" }}</span>
        </Button>
      </div>

      <p class="generated-token-expiry">Expires {{ formattedExpiry }}</p>

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
import { showControlPlaneToast } from "../useControlPlaneToasts";

const props = defineProps<{
  expiresAt: string;
  title: string;
  token: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const copied = ref(false);
const formattedExpiry = computed(() => {
  const expiresAt = new Date(props.expiresAt);
  return Number.isNaN(expiresAt.getTime()) ? props.expiresAt : expiresAt.toLocaleString();
});

watch(() => props.token, () => {
  copied.value = false;
});

async function copyToken() {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard access is unavailable.");
    }
    await navigator.clipboard.writeText(props.token);
    copied.value = true;
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Could not copy token.");
  }
}
</script>

<style scoped>
.generated-token-dialog {
  width: min(560px, calc(100vw - 36px));
}

.generated-token-field {
  display: flex;
  align-items: stretch;
  gap: 10px;
}

.generated-token-field code {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  overflow-wrap: anywhere;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-inset);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}

.generated-token-expiry {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

@media (max-width: 520px) {
  .generated-token-field {
    flex-direction: column;
  }
}
</style>
