<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="instance-delete-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("instances.deleteDialog.title", { name: instance?.name || "" }) }}</DialogTitle>
        <DialogDescription>{{ t("instances.deleteDialog.description") }}</DialogDescription>
      </DialogHeader>

      <div class="instance-delete-warning" role="note">
        <TriangleAlert :size="18" />
        <span>{{ t("instances.deleteDialog.irreversible") }}</span>
      </div>

      <label v-if="!result?.completed" class="instance-delete-data-option">
        <Checkbox :model-value="deleteVolumes" :disabled="submitting" @update:model-value="deleteVolumes = $event === true" />
        <span>
          <strong>{{ t("instances.deleteDialog.deleteData") }}</strong>
          <small>{{ deleteVolumes ? t("instances.deleteDialog.deleteDataHint") : t("instances.deleteDialog.retainDataHint") }}</small>
        </span>
      </label>

      <div v-if="error" class="instance-delete-error" role="alert">{{ error }}</div>

      <section v-if="result?.volumeResults.some((volume) => volume.status === 'failed')" class="instance-delete-results" aria-live="polite">
        <strong>{{ t("instances.deleteDialog.partialFailure") }}</strong>
        <ul>
          <li v-for="volume in result.volumeResults.filter((item) => item.status === 'failed')" :key="volume.name">
            <code>{{ volume.name }}</code><span>{{ volume.error?.message }}</span>
          </li>
        </ul>
      </section>

      <section v-if="result?.retainedVolumes.length" class="instance-delete-results retained" aria-live="polite">
        <strong>{{ t("instances.deleteDialog.retainedTitle") }}</strong>
        <p>{{ t("instances.deleteDialog.retainedHint") }}</p>
        <ul>
          <li v-for="volume in result.retainedVolumes" :key="volume.name">
            <span><code>{{ volume.name }}</code><small>{{ volume.role }} · {{ volume.mountPath }}</small></span>
            <Button variant="ghost" size="sm" @click="copyName(volume.name)"><Copy :size="14" /> {{ t("instances.deleteDialog.copy") }}</Button>
          </li>
        </ul>
      </section>

      <DialogFooter>
        <Button variant="outline" :disabled="submitting" @click="emit('update:open', false)">
          {{ result?.completed ? t("common.actions.close") : t("common.actions.cancel") }}
        </Button>
        <Button v-if="!result?.completed" variant="destructive" :disabled="submitting" @click="emit('confirm', deleteVolumes)">
          <LoaderCircle v-if="submitting" class="spin" :size="14" />
          {{ result ? t("instances.deleteDialog.retry") : submitting ? t("instances.actions.deleting") : t("instances.deleteDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { InstanceDeleteResult } from "@task-handoff/protocol/control-plane";
import { Copy, LoaderCircle, TriangleAlert } from "@lucide/vue";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { InstanceBoardItem } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";

const props = defineProps<{
  error?: string;
  instance?: InstanceBoardItem;
  open: boolean;
  result?: InstanceDeleteResult;
  submitting: boolean;
}>();
const emit = defineEmits<{ "update:open": [open: boolean]; confirm: [deleteVolumes: boolean] }>();
const { t } = useI18n();
const deleteVolumes = ref(true);

watch(() => [props.open, props.instance?.id], ([open]) => {
  if (open) deleteVolumes.value = true;
});

function setOpen(open: boolean) {
  if (!props.submitting) emit("update:open", open);
}

async function copyName(name: string) {
  await navigator.clipboard.writeText(name);
}
</script>

<style scoped>
.instance-delete-dialog { max-width: 520px; }
.instance-delete-warning, .instance-delete-error { display: flex; gap: 10px; align-items: flex-start; border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.5; }
.instance-delete-warning { color: hsl(var(--destructive)); background: hsl(var(--destructive) / .08); }
.instance-delete-error { color: hsl(var(--destructive)); border: 1px solid hsl(var(--destructive) / .24); }
.instance-delete-data-option { display: flex; gap: 11px; align-items: flex-start; padding: 12px; border: 1px solid hsl(var(--border)); border-radius: 8px; cursor: pointer; }
.instance-delete-data-option > span, .instance-delete-results li > span { display: grid; gap: 3px; }
.instance-delete-data-option strong, .instance-delete-results strong { font-size: 13px; }
.instance-delete-data-option small, .instance-delete-results small, .instance-delete-results p, .instance-delete-results li { font-size: 12px; color: hsl(var(--muted-foreground)); }
.instance-delete-results { display: grid; gap: 8px; }
.instance-delete-results p { margin: 0; }
.instance-delete-results ul { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.instance-delete-results li { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.instance-delete-results code { color: hsl(var(--foreground)); overflow-wrap: anywhere; }
.spin { animation: instance-delete-spin 1s linear infinite; }
@keyframes instance-delete-spin { to { transform: rotate(360deg); } }
</style>
