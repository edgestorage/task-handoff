<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button type="button" variant="outline" class="control-plane-timezone-trigger" :aria-label="label">
        <span>{{ model || placeholder }}</span>
        <ChevronsUpDown :size="14" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="control-plane-timezone-popover p-0" align="start" :collision-padding="12" :side-offset="6">
      <Command :model-value="model" @update:model-value="selectTimezone">
        <CommandInput class="control-plane-timezone-search" :placeholder="searchPlaceholder" />
        <ScrollArea class="control-plane-timezone-scroll" :horizontal="false">
          <CommandList class="control-plane-timezone-list" :scrollable="false">
            <CommandEmpty>{{ emptyLabel }}</CommandEmpty>
            <CommandGroup>
              <CommandItem v-for="option in options" :key="option" :value="option">
                <Check :size="14" :class="{ invisible: option !== model }" />
                <span>{{ option }}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </ScrollArea>
      </Command>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Check, ChevronsUpDown } from "@lucide/vue";
import { Button } from "../../../components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../../components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";

defineProps<{
  emptyLabel: string;
  label: string;
  options: string[];
  placeholder: string;
  searchPlaceholder: string;
}>();

const model = defineModel<string>({ default: "" });
const open = ref(false);

function selectTimezone(value: unknown) {
  if (typeof value !== "string") return;
  model.value = value;
  open.value = false;
}
</script>

<style scoped>
.control-plane-timezone-trigger { width:100%; min-width:0; height:36px; justify-content:space-between; border-color:var(--control-plane-select-border); background:var(--control-plane-select-bg); color:var(--control-plane-select-text); padding:0 9px; font-size:13px; font-weight:400; }
.control-plane-timezone-trigger > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
:global(.control-plane-timezone-popover) { width:min(360px,var(--reka-popover-content-available-width)); max-height:min(340px,var(--reka-popover-content-available-height)); overflow:hidden; border-color:var(--control-plane-select-content-border); background:var(--control-plane-select-content-bg); color:var(--control-plane-select-content-text); }
:global(.control-plane-timezone-search) { height:36px; padding-top:0; padding-bottom:0; font-size:13px; }
:global(.control-plane-timezone-scroll) { height:min(280px,calc(var(--reka-popover-content-available-height) - 38px)); }
:global(.control-plane-timezone-scroll [data-task-handoff-scroll-viewport]) { padding-right:7px; }
:global(.control-plane-timezone-list [role="option"]) { cursor:pointer; font-size:13px; }
:global(.control-plane-timezone-list [role="option"]:hover),:global(.control-plane-timezone-list [role="option"]:focus-visible),:global(.control-plane-timezone-list [role="option"][data-highlighted]) { background:var(--surface-active); color:var(--text-strong); outline:none; }
</style>
