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
          <span>{{ t("agents.manualRun.orchestration") }}</span>
          <ControlPlaneSelect v-model="orchestrationId" :disabled="orchestrations.length <= 1" :placeholder="t('agents.manualRun.orchestrationEmpty')">
            <ControlPlaneSelectItem v-for="orchestration in orchestrations" :key="orchestration.id" :value="orchestration.id">
              {{ orchestration.isDefault ? t("agents.graph.orchestrationDefaultLabel", { name: orchestration.name }) : orchestration.name }}
            </ControlPlaneSelectItem>
          </ControlPlaneSelect>
          <small class="agent-run-hint">{{ t("agents.manualRun.orchestrationHint", { name: agentName }) }}</small>
        </label>
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
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";

const props = defineProps<{
  open: boolean;
  agentName: string;
  submitting: boolean;
  /** 该 Agent 可以作为入口成员的编排；Run 绑定其中一张，入口始终是当前 Agent。 */
  orchestrations: Array<{ id: string; name: string; isDefault: boolean }>;
  submit: (prompt: string, orchestrationId: string) => Promise<void>;
}>();
const emit = defineEmits<{ "update:open": [open: boolean] }>();
const { t } = useI18n();
const prompt = ref("");
const orchestrationId = ref("");

watch(() => props.open, (open) => {
  if (!open) return;
  prompt.value = "";
  orchestrationId.value = defaultOrchestrationId();
});

// 缺省入口用默认编排：每个 Agent 都恰好有一张，用户仍可显式切换成其它包含该 Agent 的编排。
function defaultOrchestrationId() {
  return props.orchestrations.find((orchestration) => orchestration.isDefault)?.id || props.orchestrations[0]?.id || "";
}

function setOpen(open: boolean) {
  if (!props.submitting) emit("update:open", open);
}

async function submit() {
  const value = prompt.value.trim();
  if (!value || !orchestrationId.value || props.submitting) return;
  await props.submit(value, orchestrationId.value);
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
.agent-run-hint { color:var(--text-muted); font-size:12px; line-height:1.5; }
</style>
