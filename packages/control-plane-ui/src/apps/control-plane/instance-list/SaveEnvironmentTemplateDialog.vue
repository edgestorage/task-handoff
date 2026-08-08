<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="save-environment-template-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("instances.environmentTemplateDialog.title") }}</DialogTitle>
        <DialogDescription>{{ t("instances.environmentTemplateDialog.description", { name: instance?.name || "" }) }}</DialogDescription>
      </DialogHeader>

      <label class="template-name-field">
        <span>{{ t("instances.environmentTemplateDialog.name") }}</span>
        <Input v-model="name" :disabled="submitting" :placeholder="t('instances.environmentTemplateDialog.namePlaceholder')" maxlength="160" @keydown.enter.prevent="submit" />
      </label>

      <div class="template-scope" role="note">
        <PackageCheck :size="18" />
        <div>
          <strong>{{ t("instances.environmentTemplateDialog.includesTitle") }}</strong>
          <span>{{ t("instances.environmentTemplateDialog.includes") }}</span>
          <strong>{{ t("instances.environmentTemplateDialog.excludesTitle") }}</strong>
          <span>{{ t("instances.environmentTemplateDialog.excludes") }}</span>
        </div>
      </div>

      <p class="template-pause-note"><Pause :size="14" />{{ t("instances.environmentTemplateDialog.pause") }}</p>
      <p v-if="error" class="template-save-error" role="alert">{{ error }}</p>

      <DialogFooter>
        <Button variant="outline" :disabled="submitting" @click="emit('update:open', false)">{{ t("common.actions.cancel") }}</Button>
        <Button :disabled="submitting || !name.trim()" @click="submit">
          <LoaderCircle v-if="submitting" class="spin" :size="14" />
          <PackagePlus v-else :size="14" />
          {{ submitting ? t("instances.environmentTemplateDialog.saving") : t("instances.environmentTemplateDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { LoaderCircle, PackageCheck, PackagePlus, Pause } from "@lucide/vue";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { InstanceBoardItem } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";

const props = defineProps<{ error?: string; instance?: InstanceBoardItem; open: boolean; submitting: boolean }>();
const emit = defineEmits<{ "update:open": [open: boolean]; confirm: [name: string] }>();
const { t } = useI18n();
const name = ref("");

watch(() => [props.open, props.instance?.id], ([open]) => {
  if (open) name.value = props.instance ? `${props.instance.name} ${t("instances.environmentTemplateDialog.defaultSuffix")}` : "";
});

function setOpen(open: boolean) {
  if (!props.submitting) emit("update:open", open);
}

function submit() {
  const value = name.value.trim();
  if (value && !props.submitting) emit("confirm", value);
}
</script>

<style scoped>
.save-environment-template-dialog { max-width: 540px; }
.template-name-field { display: grid; gap: 7px; }
.template-name-field > span { color: hsl(var(--muted-foreground)); font-size: 12px; font-weight: 700; }
.template-scope { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; border: 1px solid hsl(var(--border)); border-radius: 8px; background: hsl(var(--muted) / .35); padding: 12px; }
.template-scope > svg { margin-top: 1px; color: var(--status-success); }
.template-scope > div { display: grid; gap: 4px; }
.template-scope strong { color: hsl(var(--foreground)); font-size: 12px; }
.template-scope span, .template-pause-note, .template-save-error { font-size: 12px; line-height: 1.5; }
.template-scope span { color: hsl(var(--muted-foreground)); }
.template-pause-note { display: flex; align-items: center; gap: 7px; margin: 0; color: hsl(var(--muted-foreground)); }
.template-save-error { margin: 0; color: hsl(var(--destructive)); }
.spin { animation: environment-template-spin 1s linear infinite; }
@keyframes environment-template-spin { to { transform: rotate(360deg); } }
</style>
