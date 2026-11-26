<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
import { ArrowDown, ArrowUp, Check, ChevronRight, X } from "@lucide/vue";
import { STORY_CONTEXT_MAX_PROJECTS } from "@task-handoff/protocol/story-context";
import type { NodeLocalFolder } from "../../../api/types";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { moveLinkedProject, projectChoices, setProjectLinked } from "./storyProjectSelection";

const props = defineProps<{ folders: NodeLocalFolder[]; disabled: boolean }>();
const ids = defineModel<string[]>({ required: true });
const { t } = useI18n();
const compact = useMediaQuery("(max-width: 600px)");
const open = ref(false);
const search = ref("");
const linkedOnly = ref(false);
const choices = computed(() => projectChoices(props.folders, ids.value, t("stories.editor.storyContextProjectUnavailable")));
const projects = computed(() => linkedOnly.value ? choices.value.linked : choices.value.all);
const atLimit = computed(() => ids.value.length >= STORY_CONTEXT_MAX_PROJECTS);
const showOrderControls = computed(() => linkedOnly.value && !search.value.trim() && ids.value.length > 1);
const emptyLabel = computed(() => search.value.trim()
  ? t('stories.editor.storyContextNoMatches')
  : linkedOnly.value
    ? t('stories.editor.storyContextNoneLinked')
    : t('stories.editor.storyContextNoProjects'));
const summary = computed(() => {
  const linked = choices.value.linked;
  if (!linked.length) return t('stories.editor.storyContextSelect');
  if (linked.length === 1) return linked[0].name;
  if (linked.length === 2) return t('stories.editor.storyContextPair', { first: linked[0].name, second: linked[1].name });
  return t('stories.editor.storyContextSummary', { first: linked[0].name, count: linked.length });
});

function setOpen(value: boolean) {
  if (value) {
    search.value = "";
    linkedOnly.value = false;
  }
  open.value = value;
}

function setView(value: string) {
  linkedOnly.value = value === "linked";
}

function updateSearch(event: Event) {
  search.value = (event.target as HTMLInputElement).value;
}

function toggleProject(id: string) {
  const linked = choices.value.selectedIds.has(id);
  if (!linked && atLimit.value) return;
  ids.value = setProjectLinked(ids.value, id, !linked);
}

function reorderProject(id: string, offset: -1 | 1) {
  ids.value = moveLinkedProject(ids.value, id, offset);
}
</script>

<template>
  <div class="project-field">
    <component :is="compact ? Sheet : Popover" :open="open" @update:open="setOpen">
      <component :is="compact ? SheetTrigger : PopoverTrigger" as-child>
        <Button class="project-trigger" type="button" variant="ghost" :disabled="disabled">
          <span class="project-caption">{{ t('stories.editor.storyContextProjects') }}</span>
          <span class="project-value" :class="{ empty: !ids.length }">{{ summary }}</span>
          <ChevronRight :size="15" aria-hidden="true" />
        </Button>
      </component>
      <component :is="compact ? SheetContent : PopoverContent" v-bind="compact ? { side: 'bottom', showClose: false, 'aria-describedby': undefined } : { align: 'end', collisionPadding: 10, 'aria-label': t('stories.editor.storyContextProjects') }" :class="compact ? 'story-project-sheet' : 'story-project-popover'">
        <div v-if="compact" class="project-sheet-head">
          <SheetTitle class="project-sheet-title">{{ t('stories.editor.storyContextProjects') }}</SheetTitle>
          <Button type="button" variant="ghost" size="icon-sm" :aria-label="t('stories.close')" :title="t('stories.close')" @click="setOpen(false)"><X :size="16" /></Button>
        </div>
        <Tabs :model-value="linkedOnly ? 'linked' : 'all'" @update:model-value="setView">
          <TabsList class="project-tabs" :aria-label="t('stories.editor.storyContextProjects')">
            <TabsTrigger value="all">{{ t('stories.editor.storyContextAll') }}</TabsTrigger>
            <TabsTrigger value="linked">{{ t('stories.editor.storyContextLinked', { count: ids.length }) }}</TabsTrigger>
          </TabsList>
        </Tabs>
        <p v-if="atLimit" class="project-limit" role="status">{{ t('stories.editor.storyContextLimit', { count: STORY_CONTEXT_MAX_PROJECTS }) }}</p>
        <Command class="project-command">
          <CommandInput class="project-search-input" :aria-label="t('stories.editor.storyContextSearch')" :placeholder="t('stories.editor.storyContextSearch')" @input="updateSearch" />
          <ScrollArea class="project-scroll" :horizontal="false">
            <CommandList class="project-list" :scrollable="false">
              <CommandEmpty class="project-empty">{{ emptyLabel }}</CommandEmpty>
              <CommandGroup>
                <div v-for="row in projects" :key="row.id" class="project-option-row" role="presentation">
                  <CommandItem class="project-option" :value="row.id" :clear-search-on-select="false" :disabled="disabled || (!choices.selectedIds.has(row.id) && atLimit)" @select="toggleProject(row.id)">
                    <span class="project-copy">
                      <span class="project-name" :title="row.name">{{ row.name }}</span>
                      <span class="project-path" :title="row.path">{{ row.path }}</span>
                    </span>
                    <Check :size="14" class="project-check" :class="{ unselected: !choices.selectedIds.has(row.id) }" aria-hidden="true" />
                  </CommandItem>
                  <div v-if="showOrderControls" class="project-order-actions">
                    <button v-for="offset in ([-1, 1] as const)" :key="offset" type="button" class="project-order-button" :disabled="disabled || row.id === (offset < 0 ? ids[0] : ids[ids.length - 1])" :aria-label="t(offset < 0 ? 'stories.editor.storyContextMoveUp' : 'stories.editor.storyContextMoveDown', { name: row.name })" :title="t(offset < 0 ? 'stories.editor.storyContextMoveUp' : 'stories.editor.storyContextMoveDown', { name: row.name })" @click="reorderProject(row.id, offset)"><component :is="offset < 0 ? ArrowUp : ArrowDown" :size="13" /></button>
                  </div>
                </div>
              </CommandGroup>
            </CommandList>
            <p v-if="!projects.length && !search.trim()" class="project-empty" role="status">{{ emptyLabel }}</p>
          </ScrollArea>
        </Command>
      </component>
    </component>
  </div>
</template>

<style scoped>
.project-field { --row-inset:10px; min-width:0; margin-inline:calc(0px - var(--row-inset)); container-type:inline-size; }
.project-trigger { display:grid; width:100%; height:auto; min-height:36px; grid-template-columns:auto minmax(0,1fr) auto; gap:12px; padding:6px var(--row-inset); text-align:start; font-weight:400; }
.project-caption,.project-value.empty,.project-trigger svg { color:var(--text-muted); }
.project-caption { font-size:12px; }
.project-value { font-size:13px; white-space:normal; overflow-wrap:anywhere; }
@container (max-width:340px) { .project-trigger { grid-template-columns:minmax(0,1fr) auto; gap:4px 8px; } .project-value { grid-row:2; } .project-trigger svg { grid-column:2; grid-row:1 / span 2; } }
:global(.story-project-popover.story-project-popover),:global(.story-project-sheet.story-project-sheet) { display:flex; flex-direction:column; overflow:hidden; gap:3px; border-color:var(--control-plane-select-content-border); background:var(--control-plane-select-content-bg); color:var(--control-plane-select-content-text); }
:global(.story-project-popover.story-project-popover) { width:min(360px,var(--reka-popover-content-available-width)); height:min(360px,var(--reka-popover-content-available-height)); padding:4px; }
:global(.story-project-sheet.story-project-sheet) { height:min(460px,calc(100dvh - 20px)); gap:6px; border-radius:8px 8px 0 0; padding:10px 12px max(10px,env(safe-area-inset-bottom)); }
.project-sheet-head { display:flex; align-items:center; justify-content:space-between; min-height:30px; padding:0 2px 2px; }
.project-sheet-title { color:var(--text-strong); font-size:15px; font-weight:500; }
.project-tabs { display:inline-flex; align-self:flex-start; height:27px; min-height:27px; border:0; border-radius:5px; background:var(--surface-inset); padding:2px; }
.project-tabs :deep(button) { height:23px; min-height:23px; border-radius:4px; color:var(--text-muted); font-size:12px; font-weight:400; padding:0 8px; }
.project-tabs :deep(button:not([data-state="active"]):hover) { background:var(--surface-hover); color:var(--text-strong); }
.project-tabs :deep(button[data-state="active"]) { background:var(--surface-active); color:var(--text-strong); box-shadow:none; }
.project-limit,.project-empty { margin:0; color:var(--text-muted); font-size:12px; }
.project-limit { padding:4px 2px 2px; }
.project-command { display:grid; flex:1; height:auto; min-height:0; grid-template-rows:auto minmax(0,1fr); overflow:hidden; border-radius:0; background:transparent; color:inherit; }
.project-command :deep([cmdk-input-wrapper]) { height:34px; gap:7px; margin:0 0 3px; padding:0 9px; border:1px solid var(--line-subtle); border-radius:6px; background:var(--surface-inset); }
.project-command :deep([cmdk-input-wrapper]:focus-within) { border-color:var(--focus-ring); }
.project-command :deep([cmdk-input-wrapper] > svg) { width:14px; height:14px; margin-right:0; }
.project-command :deep([cmdk-input-wrapper] input) { height:30px; padding:0; font-size:13px; }
.project-command :deep([role="group"]) { display:grid; grid-template-columns:minmax(0,1fr); gap:2px; padding:0; }
.project-scroll { min-height:0; }
.project-scroll :deep([data-task-handoff-scroll-viewport]) { padding-right:7px; }
.project-option-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; border-radius:5px; }
.project-option-row:not(:has([role="option"])) { display:none; }
.project-option-row:hover,.project-option-row:has([data-highlighted]) { background:var(--surface-hover); }
.project-option { display:grid; width:100%; min-height:44px; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; padding:5px 8px; border-radius:5px; background:transparent !important; color:inherit; font-size:13px; }
.project-option:hover,.project-option[data-highlighted] { background:transparent !important; color:var(--text-strong); }
.project-copy { display:grid; min-width:0; gap:2px; }
.project-name,.project-path { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.project-name { color:var(--text-strong); font-weight:500; line-height:16px; }
.project-path { color:var(--text-muted); font-size:12px; font-weight:400; line-height:15px; }
.project-check { flex:0 0 auto; color:var(--text-strong); }
.project-check.unselected { opacity:0; }
.project-order-actions { display:flex; align-items:center; gap:1px; padding-right:3px; }
.project-order-button { display:grid; width:22px; height:22px; place-items:center; border:0; border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer; padding:0; }
.project-order-button:hover:not(:disabled) { background:var(--surface-active); color:var(--text-strong); }
.project-order-button:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
.project-order-button:disabled { cursor:default; opacity:.3; }
.project-empty { padding:22px 10px; text-align:center; }
</style>
