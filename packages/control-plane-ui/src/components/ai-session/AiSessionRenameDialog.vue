<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="ai-session-rename-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("sessions.rename.title") }}</DialogTitle>
        <DialogDescription>{{ t("sessions.rename.description") }}</DialogDescription>
      </DialogHeader>
      <form class="ai-session-rename-form" @submit.prevent="submit">
        <label for="ai-session-title">{{ t("sessions.rename.label") }}</label>
        <Input
          id="ai-session-title"
          v-model="draft"
          :disabled="busy"
          :maxlength="120"
          autocomplete="off"
          autofocus
        />
        <p v-if="error" class="ai-session-rename-error" role="alert">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="setOpen(false)">{{ t("common.actions.cancel") }}</Button>
          <Button type="submit" :disabled="!canSubmit">
            <LoaderCircle v-if="busy" class="spin" :size="14" />
            <span>{{ t("common.actions.save") }}</span>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import { renameAiSession } from "../../api/queries";
import { translateApiError } from "../../i18n/apiError";
import { createBrowserUuid } from "../../lib/random-id";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

const props = defineProps<{
  instanceId: string;
  open: boolean;
  session?: AiSessionSummary;
}>();
const emit = defineEmits<{
  renamed: [title: string];
  "update:open": [open: boolean];
}>();
const { t } = useI18n();
const draft = ref("");
const expectedTitle = ref("");
const clientRequestId = ref("");
const busy = ref(false);
const error = ref("");
const normalized = computed(() => draft.value.trim());
const canSubmit = computed(() => !busy.value && normalized.value.length <= 120 && normalized.value !== expectedTitle.value);

watch(() => [props.open, props.session?.id] as const, ([open]) => {
  if (!open || !props.session) return;
  expectedTitle.value = props.session.title?.trim() || "";
  draft.value = expectedTitle.value;
  clientRequestId.value = createBrowserUuid();
  error.value = "";
  busy.value = false;
}, { immediate: true });

function setOpen(open: boolean) {
  if (busy.value) return;
  emit("update:open", open);
}

async function submit() {
  const session = props.session;
  if (!session || !canSubmit.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await renameAiSession(props.instanceId, session.id, {
      title: normalized.value,
      expectedTitle: expectedTitle.value,
      clientRequestId: clientRequestId.value,
    });
    emit("renamed", result.title);
    emit("update:open", false);
  } catch (cause) {
    error.value = translateApiError(cause, t, t("sessions.rename.failed"));
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.ai-session-rename-form {
  display: grid;
  gap: 12px;
}

.ai-session-rename-form label,
.ai-session-rename-error {
  font-size: 13px;
  font-weight: 400;
}

.ai-session-rename-error {
  color: var(--status-danger);
  margin: 0;
}

.spin {
  animation: ai-session-rename-spin 0.8s linear infinite;
}

@keyframes ai-session-rename-spin {
  to { transform: rotate(360deg); }
}
</style>
