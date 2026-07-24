<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="repository-delivery-dialog">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>

      <RepositoryErrorNotice v-if="errorCause" :error="errorCause" fallback="Repository delivery failed." />
      <div v-if="success" class="repository-delivery-message success" role="status"><CheckCircle2 :size="15" /><span>{{ success }}</span></div>

      <section v-if="context.primaryAction === 'publish-branch'" class="repository-delivery-form">
        <label>Remote</label>
        <ControlPlaneSelect v-model="selectedRemote" :disabled="Boolean(pending)" placeholder="Select a configured remote">
          <ControlPlaneSelectItem v-for="remote in context.remotes || []" :key="remote.name" :value="remote.name">{{ remote.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <label for="repository-publish-target">Remote branch</label>
        <Input id="repository-publish-target" v-model="targetBranch" :disabled="pending" autocomplete="off" />
        <label class="repository-delivery-checkbox">
          <Checkbox v-model="setUpstream" :disabled="Boolean(pending)" />
          <span><strong>Set as upstream</strong><small>This changes tracking configuration and requires this explicit confirmation.</small></span>
        </label>
      </section>

      <section v-else-if="context.primaryAction === 'push'" class="repository-delivery-summary">
        <span><strong>Source</strong><small>{{ currentBranch }}</small></span>
        <span><strong>Destination</strong><small>{{ context.upstream?.remote }}/{{ context.upstream?.branch }}</small></span>
        <p>Push uses an explicit refspec and never uses force.</p>
      </section>

      <section v-else-if="context.primaryAction === 'pull'" class="repository-delivery-summary">
        <span><strong>Upstream</strong><small>{{ context.upstream?.ref }}</small></span>
        <span><strong>Mode</strong><small>Fast-forward only</small></span>
        <p>No merge commit or rebase will be created.</p>
      </section>

      <section v-else-if="context.primaryAction === 'diverged'" class="repository-delivery-blocked">
        <GitCompareArrows :size="21" />
        <span><strong>Automatic synchronization is blocked.</strong><small>The branch is {{ context.upstream?.ahead || 0 }} ahead and {{ context.upstream?.behind || 0 }} behind. Resolve it in the session terminal, then refresh Environment.</small></span>
      </section>

      <section v-else-if="context.primaryAction === 'up-to-date'" class="repository-delivery-blocked ready">
        <CheckCircle2 :size="21" />
        <span><strong>Branch is up to date.</strong><small>Fetch a configured remote to check for newer remote refs.</small></span>
      </section>

      <section v-if="context.remotes?.length" class="repository-fetch-row">
        <span><strong>Fetch remote</strong><small>Refresh remote-tracking refs without changing the worktree.</small></span>
        <ControlPlaneSelect v-model="selectedRemote" :disabled="Boolean(pending)" placeholder="Remote">
          <ControlPlaneSelectItem v-for="remote in context.remotes" :key="remote.name" :value="remote.name">{{ remote.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <Button variant="outline" :disabled="pending || !selectedRemote" @click="fetchRemote"><RefreshCw :class="{ spin: pending === 'fetch' }" :size="14" /> Fetch</Button>
      </section>

      <DialogFooter>
        <Button variant="outline" :disabled="Boolean(pending)" @click="$emit('update:open', false)">Close</Button>
        <Button v-if="actionAvailable" :disabled="Boolean(pending) || !canRunPrimary" @click="runPrimary">
          <LoaderCircle v-if="pending && pending !== 'fetch'" class="spin" :size="14" />
          <UploadCloud v-else-if="context.primaryAction === 'publish-branch' || context.primaryAction === 'push'" :size="14" />
          <DownloadCloud v-else :size="14" />
          {{ pending && pending !== "fetch" ? "Working…" : primaryButtonLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { RepositoryBranchMutationResult, RepositoryContext, RepositorySessionKind } from "@task-handoff/protocol/repository";
import { CheckCircle2, DownloadCloud, GitCompareArrows, LoaderCircle, RefreshCw, UploadCloud } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { fetchRepositoryRemote, publishRepositoryBranch, pullRepositoryBranch, pushRepositoryBranch } from "../../../api/repository";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import RepositoryErrorNotice from "./RepositoryErrorNotice.vue";

const props = defineProps<{
  context: RepositoryContext;
  instanceId: string;
  open: boolean;
  sessionId: string;
  sessionKind: RepositorySessionKind;
}>();

defineEmits<{ "update:open": [open: boolean] }>();

const queryClient = useQueryClient();
const selectedRemote = ref("");
const targetBranch = ref("");
const setUpstream = ref(true);
const pending = ref<"fetch" | "primary" | "">("");
const errorCause = ref<unknown>();
const success = ref("");
const target = computed(() => ({ instanceId: props.instanceId, sessionKind: props.sessionKind, sessionId: props.sessionId }));
const currentBranch = computed(() => props.context.head?.state === "branch" ? props.context.head.branch || "" : "");
const actionAvailable = computed(() => ["publish-branch", "push", "pull"].includes(props.context.primaryAction || ""));
const canRunPrimary = computed(() => {
  if (!props.context.snapshotId || !currentBranch.value) return false;
  if (props.context.primaryAction === "publish-branch") return Boolean(selectedRemote.value && targetBranch.value.trim());
  if (props.context.primaryAction === "push") return Boolean(props.context.upstream?.remote && props.context.upstream.branch);
  return props.context.primaryAction === "pull" && Boolean(props.context.upstream);
});
const title = computed(() => ({
  "publish-branch": "Publish branch",
  push: "Push branch",
  pull: "Pull fast-forward",
  diverged: "Branch diverged",
  "up-to-date": "Branch up to date",
}[props.context.primaryAction || "up-to-date"] || "Repository delivery"));
const description = computed(() => ({
  "publish-branch": "Choose an explicit remote and target branch. No hosting-platform integration is required.",
  push: "Confirm the exact local source and upstream destination before pushing.",
  pull: "Update the current branch only when Git can fast-forward it cleanly.",
  diverged: "The server has blocked automatic pull and push for this state.",
  "up-to-date": "No delivery mutation is currently required.",
}[props.context.primaryAction || "up-to-date"] || "Repository delivery state."));
const primaryButtonLabel = computed(() => ({ "publish-branch": "Publish", push: "Push", pull: "Pull --ff-only" }[props.context.primaryAction || ""] || "Continue"));

watch(() => props.open, (open) => {
  if (!open) return;
  selectedRemote.value = props.context.upstream?.remote || props.context.remotes?.[0]?.name || "";
  targetBranch.value = currentBranch.value;
  setUpstream.value = true;
  errorCause.value = undefined;
  success.value = "";
});

async function fetchRemote() {
  if (!selectedRemote.value || !props.context.snapshotId || pending.value) return;
  await run("fetch", () => fetchRepositoryRemote(target.value, { remote: selectedRemote.value, expectedSnapshotId: props.context.snapshotId! }), `Fetched ${selectedRemote.value}.`);
}

async function runPrimary() {
  if (!canRunPrimary.value || !props.context.snapshotId || pending.value) return;
  const action = props.context.primaryAction;
  if (action === "publish-branch") {
    await run("primary", () => publishRepositoryBranch(target.value, {
      remote: selectedRemote.value,
      sourceBranch: currentBranch.value,
      targetBranch: targetBranch.value.trim(),
      setUpstream: setUpstream.value,
      ...(setUpstream.value ? { confirmSetUpstream: true as const } : {}),
      expectedSnapshotId: props.context.snapshotId!,
    }), `Published ${currentBranch.value}.`);
  } else if (action === "push" && props.context.upstream) {
    await run("primary", () => pushRepositoryBranch(target.value, {
      remote: props.context.upstream!.remote,
      sourceBranch: currentBranch.value,
      targetBranch: props.context.upstream!.branch,
      expectedSnapshotId: props.context.snapshotId!,
    }), `Pushed ${currentBranch.value}.`);
  } else if (action === "pull") {
    await run("primary", () => pullRepositoryBranch(target.value, { expectedSnapshotId: props.context.snapshotId! }), `Fast-forwarded ${currentBranch.value}.`);
  }
}

async function run(kind: "fetch" | "primary", operation: () => Promise<RepositoryBranchMutationResult>, message: string) {
  pending.value = kind;
  errorCause.value = undefined;
  success.value = "";
  try {
    const result = await operation();
    queryClient.setQueryData(["repository-context", props.instanceId, props.sessionKind, props.sessionId], result.context);
    queryClient.setQueryData(["repository-branches", props.instanceId, props.sessionKind, props.sessionId], result.branches);
    success.value = message;
  } catch (cause) {
    errorCause.value = cause;
  } finally {
    pending.value = "";
  }
}
</script>

<style scoped>
:global([role="dialog"].repository-delivery-dialog) { width: min(560px, calc(100vw - 32px)); gap: 14px; border-color: var(--line-subtle); background: hsl(var(--background)); color: var(--text); }
.repository-delivery-form, .repository-delivery-summary { display: grid; gap: 8px; }
.repository-delivery-form > label { color: var(--text-muted); font-size: 10px; font-weight: 700; }
.repository-delivery-form :deep(input) { font: 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.repository-delivery-checkbox { display: flex; align-items: flex-start; gap: 8px; border: 1px solid var(--line-subtle); border-radius: 7px; padding: 9px; }
.repository-delivery-checkbox > span, .repository-delivery-blocked > span, .repository-fetch-row > span { display: grid; gap: 2px; }
.repository-delivery-checkbox strong, .repository-delivery-summary strong, .repository-fetch-row strong, .repository-delivery-blocked strong { color: var(--text-strong); font-size: 11px; }
.repository-delivery-checkbox small, .repository-delivery-summary small, .repository-fetch-row small, .repository-delivery-blocked small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }
.repository-delivery-summary { grid-template-columns: 1fr 1fr; }
.repository-delivery-summary > span { display: grid; gap: 3px; border: 1px solid var(--line-subtle); border-radius: 7px; padding: 9px; }
.repository-delivery-summary p { grid-column: 1 / -1; margin: 0; color: var(--text-muted); font-size: 10px; }
.repository-delivery-blocked { display: flex; align-items: flex-start; gap: 9px; border: 1px solid color-mix(in srgb, var(--status-warning) 35%, var(--line-subtle)); border-radius: 8px; color: var(--status-warning); padding: 11px; }
.repository-delivery-blocked.ready { border-color: color-mix(in srgb, var(--status-success) 35%, var(--line-subtle)); color: var(--status-success); }
.repository-fetch-row { display: grid; grid-template-columns: minmax(0, 1fr) 150px auto; align-items: center; gap: 8px; border-top: 1px solid var(--line-subtle); padding-top: 12px; }
.repository-fetch-row :deep(button), :global([role="dialog"].repository-delivery-dialog button) { gap: 6px; }
.repository-delivery-message.success { display: flex; align-items: flex-start; gap: 8px; border-radius: 7px; background: var(--status-success-bg); color: var(--status-success); padding: 9px; font-size: 10px; }
.spin { animation: repository-delivery-spin 0.9s linear infinite; }
@keyframes repository-delivery-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) { .repository-fetch-row { grid-template-columns: 1fr; } .repository-delivery-summary { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
