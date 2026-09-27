<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="agent-run-dialog">
      <DialogHeader class="agent-run-dialog-header">
        <div>
          <DialogTitle>{{ t("agents.manualRun.title", { name: agentName }) }}</DialogTitle>
          <DialogDescription>{{ t("agents.manualRun.description") }}</DialogDescription>
        </div>
        <DialogClose as-child>
          <button type="button" class="agent-run-dialog-close" :aria-label="t('common.actions.close')" :disabled="submitting">
            <X :size="16" />
          </button>
        </DialogClose>
      </DialogHeader>

      <form class="agent-run-form" @submit.prevent="submit">
        <label class="agent-run-field">
          <span>{{ t("agents.manualRun.prompt") }}</span>
          <Textarea
            v-model="prompt"
            class="agent-run-prompt"
            :maxlength="128000"
            :placeholder="t('agents.manualRun.promptPlaceholder')"
          />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="submitting" @click="setOpen(false)">{{ t("common.actions.cancel") }}</Button>
          <Button type="submit" :disabled="!prompt.trim() || submitting">
            <Play :size="14" />
            {{ submitting ? t("agents.manualRun.starting") : t("agents.manualRun.start") }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Play, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import Textarea from "@/components/ui/textarea/Textarea.vue";

const props = defineProps<{
  open: boolean;
  agentName: string;
  submitting: boolean;
  submit: (prompt: string) => Promise<void>;
}>();
const emit = defineEmits<{ "update:open": [open: boolean] }>();
const { t } = useI18n();
const prompt = ref("");

watch(() => props.open, (open) => {
  if (open) prompt.value = "";
});

function setOpen(open: boolean) {
  if (!props.submitting) emit("update:open", open);
}

async function submit() {
  const value = prompt.value.trim();
  if (!value || props.submitting) return;
  await props.submit(value);
}
</script>

<style scoped>
.agent-run-dialog { width:min(560px,calc(100vw - 24px)); }
.agent-run-dialog-header { display:flex; flex-direction:row; align-items:flex-start; justify-content:space-between; gap:16px; }
.agent-run-dialog-close { display:grid; width:30px; height:30px; flex:none; place-items:center; border:0; border-radius:6px; background:transparent; color:var(--text-muted); cursor:pointer; }
.agent-run-dialog-close:hover { background:var(--surface-active); color:var(--text-strong); }
.agent-run-form { display:grid; gap:18px; }
.agent-run-field { display:grid; gap:7px; color:var(--text-strong); font-size:12px; font-weight:400; }
.agent-run-prompt { min-height:140px; resize:vertical; font-size:13px; line-height:1.5; }
</style>
