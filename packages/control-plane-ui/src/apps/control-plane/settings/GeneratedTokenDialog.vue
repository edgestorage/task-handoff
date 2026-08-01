<template>
  <Dialog :open="Boolean(token)" @update:open="(open) => !open && emit('close')">
    <DialogContent class="generated-token-dialog">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>
          {{ t("settings.nodeDialogs.tokenOnce") }}
        </DialogDescription>
      </DialogHeader>

      <div class="generated-token-field">
        <code>{{ token }}</code>
        <Button size="sm" @click="copyToken">
          <Check v-if="copied" :size="15" />
          <Copy v-else :size="15" />
          <span>{{ copied ? t("settings.nodeDialogs.copied") : t("settings.nodeDialogs.copyToken") }}</span>
        </Button>
      </div>

      <dl v-if="details?.length" class="generated-token-details">
        <template v-for="detail in details" :key="detail.label">
          <dt>{{ detail.label }}</dt>
          <dd>{{ detail.value }}</dd>
        </template>
      </dl>

      <p class="generated-token-expiry">{{ t("settings.nodeDialogs.expires", { time: formattedExpiry }) }}</p>

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
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";

const { t } = useI18n();
const { locale } = useControlPlaneLocale();

const props = defineProps<{
  expiresAt: string;
  title: string;
  token: string;
  details?: Array<{ label: string; value: string }>;
}>();

const emit = defineEmits<{
  close: [];
}>();

const copied = ref(false);
const formattedExpiry = computed(() => {
  const expiresAt = new Date(props.expiresAt);
  return Number.isNaN(expiresAt.getTime()) ? props.expiresAt : formatDateTime(expiresAt, locale.value);
});

watch(() => props.token, () => {
  copied.value = false;
});

async function copyToken() {
  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error(t("settings.nodeDialogs.clipboardUnavailable"));
    }
    await navigator.clipboard.writeText(props.token);
    copied.value = true;
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : t("settings.nodeDialogs.copyTokenFailed"));
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

.generated-token-details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0;
  font-size: 12px;
}

.generated-token-details dt { color: var(--text-muted); }
.generated-token-details dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }

@media (max-width: 520px) {
  .generated-token-field {
    flex-direction: column;
  }
}
</style>
