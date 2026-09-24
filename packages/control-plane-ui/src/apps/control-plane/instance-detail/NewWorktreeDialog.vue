<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="new-worktree-dialog">
      <DialogHeader>
        <DialogTitle>{{ t("sessions.panel.newWorktree") }}</DialogTitle>
        <DialogDescription>{{ description || t("sessions.panel.newWorktreeDescription") }}</DialogDescription>
      </DialogHeader>
      <form class="new-worktree-form" @submit.prevent="confirm">
        <ToggleGroup
          type="single"
          class="new-worktree-modes"
          :aria-label="t('sessions.panel.newWorktreeMode')"
          :model-value="mode"
          @update:model-value="setMode"
        >
          <ToggleGroupItem value="existing-branch" size="xs"><GitBranch :size="13" />{{ t("sessions.panel.existingBranch") }}</ToggleGroupItem>
          <ToggleGroupItem value="new-branch" size="xs"><Plus :size="13" />{{ t("sessions.panel.newBranch") }}</ToggleGroupItem>
        </ToggleGroup>

        <div v-if="mode === 'existing-branch'" class="new-worktree-field">
          <label for="new-worktree-existing-branch">{{ t("sessions.panel.branch") }}</label>
          <NewWorktreeBranchPicker
            id="new-worktree-existing-branch"
            v-model="branchName"
            :branches="branches"
            :disabled="busy"
            selectable-only
            show-detached
          />
          <small v-if="selectedBranch?.worktreeCheckout === 'detached'" class="new-worktree-detached-hint">{{ t("sessions.panel.newWorktreeDetachedDescription") }}</small>
        </div>

        <template v-else>
          <div class="new-worktree-field">
            <label for="new-worktree-branch">{{ t("sessions.panel.newWorktreeBranch") }}</label>
            <ControlPlaneInput id="new-worktree-branch" v-model="newBranchName" :maxlength="255" :disabled="busy" autofocus />
          </div>
          <div class="new-worktree-field">
            <label for="new-worktree-start-ref">{{ t("sessions.panel.newWorktreeStartRef") }}</label>
            <NewWorktreeBranchPicker
              id="new-worktree-start-ref"
              v-model="startRef"
              :branches="branches"
              :disabled="busy"
            />
          </div>
        </template>

        <slot />

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="busy" @click="emit('update:open', false)">{{ t("common.actions.cancel") }}</Button>
          <Button type="submit" :disabled="!canConfirm">
            <LoaderCircle v-if="busy" class="new-worktree-spin" :size="14" />
            {{ busy ? busyLabel : confirmLabel }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { GitBranch, LoaderCircle, Plus } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import NewWorktreeBranchPicker, { type NewWorktreeBranch } from "./NewWorktreeBranchPicker.vue";

export type { NewWorktreeBranch } from "./NewWorktreeBranchPicker.vue";
export type NewWorktreeSelection =
  | { mode: "existing-branch"; branchName: string }
  | { mode: "new-branch"; branchName: string; startRef: string };

const props = withDefaults(defineProps<{
  branches: NewWorktreeBranch[];
  busy?: boolean;
  busyLabel?: string;
  confirmEnabled?: boolean;
  confirmLabel?: string;
  defaultStartRef?: string;
  description?: string;
  initialSelection?: NewWorktreeSelection;
  open: boolean;
}>(), {
  busy: false,
  busyLabel: "",
  confirmEnabled: true,
  confirmLabel: "",
  defaultStartRef: "HEAD",
  description: "",
  initialSelection: undefined,
});
const emit = defineEmits<{
  confirm: [selection: NewWorktreeSelection];
  "update:open": [open: boolean];
}>();
const { t } = useI18n();

const mode = ref<"existing-branch" | "new-branch">("existing-branch");
const branchName = ref("");
const newBranchName = ref("");
const startRef = ref("HEAD");
const selectedBranch = computed(() => props.branches.find((branch) => branch.name === branchName.value && branch.worktreeSelectable));
const preferredStartRef = computed(() => (
  props.branches.find((branch) => branch.name === "main")?.name
  || props.branches.find((branch) => branch.name === "master")?.name
  || props.defaultStartRef
  || "HEAD"
));
const canConfirm = computed(() => Boolean(
  !props.busy
  && props.confirmEnabled
  && (mode.value === "existing-branch" ? selectedBranch.value : newBranchName.value.trim() && startRef.value.trim()),
));
const confirmLabel = computed(() => props.confirmLabel || t("sessions.panel.useNewWorktree"));
const busyLabel = computed(() => props.busyLabel || confirmLabel.value);

watch(() => props.open, (open, wasOpen) => {
  if (!open || wasOpen) return;
  const initial = props.initialSelection;
  mode.value = initial?.mode || "existing-branch";
  branchName.value = initial?.mode === "existing-branch"
    ? initial.branchName
    : props.branches.find((branch) => branch.worktreeSelectable)?.name || "";
  newBranchName.value = initial?.mode === "new-branch" ? initial.branchName : "";
  startRef.value = initial?.mode === "new-branch" ? initial.startRef : preferredStartRef.value;
});

watch(() => props.branches, (branches) => {
  if (!props.open) return;
  if (mode.value === "existing-branch") {
    if (selectedBranch.value) return;
    branchName.value = branches.find((branch) => branch.worktreeSelectable && branch.name === props.defaultStartRef)?.name
      || branches.find((branch) => branch.worktreeSelectable)?.name
      || "";
    return;
  }
  if (startRef.value === "HEAD" || startRef.value === props.defaultStartRef) startRef.value = preferredStartRef.value;
});

function setMode(value: unknown) {
  if (value === "existing-branch" || value === "new-branch") mode.value = value;
}

function confirm() {
  if (!canConfirm.value) return;
  emit("confirm", mode.value === "existing-branch"
    ? { mode: "existing-branch", branchName: branchName.value }
    : { mode: "new-branch", branchName: newBranchName.value.trim(), startRef: startRef.value.trim() });
}

</script>

<style scoped>
:global([role="dialog"].new-worktree-dialog) {
  width: min(520px, calc(100vw - 32px));
}

.new-worktree-form,
.new-worktree-field {
  display: grid;
  gap: 8px;
}

.new-worktree-form { gap: 16px; }
.new-worktree-field > label { color: var(--text-strong); font-size: 12px; font-weight: 500; }

.new-worktree-modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-raised);
  padding: 3px;
}

.new-worktree-modes > button { gap: 6px; min-width: 0; border-radius: 4px; font-size: 12px; font-weight: 400; }
.new-worktree-modes > button[data-state="on"] { background: var(--surface-active); color: var(--text-strong); }

.new-worktree-detached-hint { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.new-worktree-detached-hint { line-height: 1.45; }
.new-worktree-spin { animation: new-worktree-spin 0.8s linear infinite; }
@keyframes new-worktree-spin { to { transform: rotate(360deg); } }
</style>
