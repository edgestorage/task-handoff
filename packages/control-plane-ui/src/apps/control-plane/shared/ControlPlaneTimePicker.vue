<template>
  <Popover v-model:open="open">
    <div class="control-plane-time-picker">
      <input
        :value="draft"
        class="control-plane-time-picker-input"
        inputmode="numeric"
        maxlength="5"
        :aria-label="timeLabel"
        @blur="commitDraft"
        @focus="draft = model"
        @input="updateDraft"
        @keydown.up.prevent="stepTime(1)"
        @keydown.down.prevent="stepTime(-1)"
      />
      <PopoverTrigger as-child>
        <button type="button" class="control-plane-time-picker-trigger" :aria-label="openPickerLabel">
          <Clock :size="15" />
        </button>
      </PopoverTrigger>
    </div>
    <PopoverContent class="control-plane-time-picker-popover p-0" align="start" :collision-padding="12" :side-offset="6">
      <div class="control-plane-time-picker-columns">
        <div class="control-plane-time-picker-column">
          <span>{{ hourLabel }}</span>
          <ScrollArea class="control-plane-time-picker-scroll" :horizontal="false">
            <div class="control-plane-time-picker-options">
              <button
                v-for="option in hourOptions"
                :key="option"
                type="button"
                :class="{ selected: option === hour }"
                :aria-pressed="option === hour"
                @click="selectHour(option)"
              >{{ option }}</button>
            </div>
          </ScrollArea>
        </div>
        <div class="control-plane-time-picker-column">
          <span>{{ minuteLabel }}</span>
          <ScrollArea class="control-plane-time-picker-scroll" :horizontal="false">
            <div class="control-plane-time-picker-options">
              <button
                v-for="option in minuteOptions"
                :key="option"
                type="button"
                :class="{ selected: option === minute }"
                :aria-pressed="option === minute"
                @click="selectMinute(option)"
              >{{ option }}</button>
            </div>
          </ScrollArea>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Clock } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";

const props = defineProps<{
  hourLabel: string;
  minuteLabel: string;
  openLabel?: string;
}>();

const model = defineModel<string>({ default: "00:00" });
const open = ref(false);
const draft = ref(model.value);
const hourOptions = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const minuteOptions = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
const timeLabel = computed(() => `${props.hourLabel}:${props.minuteLabel}`);
const openPickerLabel = computed(() => props.openLabel || timeLabel.value);
const hour = computed(() => validTime(model.value).slice(0, 2));
const minute = computed(() => validTime(model.value).slice(3, 5));

watch(model, (value) => { draft.value = validTime(value); });
watch(open, async (isOpen) => {
  if (!isOpen) return;
  await nextTick();
  document.querySelectorAll<HTMLButtonElement>(`.control-plane-time-picker-options button[aria-pressed="true"]`).forEach((button) => button.scrollIntoView({ block: "center" }));
});

function validTime(value: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value) ? value : "00:00";
}

function parsedTime(value: string) {
  const trimmed = value.trim();
  const colonMatch = /^(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  const compactMatch = digits.length === 3 || digits.length === 4
    ? [digits, digits.slice(0, -2), digits.slice(-2)]
    : undefined;
  const match = colonMatch || compactMatch;
  if (!match) return undefined;
  const nextHour = Number(match[1]);
  const nextMinute = Number(match[2]);
  if (nextHour > 23 || nextMinute > 59) return undefined;
  return `${String(nextHour).padStart(2, "0")}:${String(nextMinute).padStart(2, "0")}`;
}

function updateDraft(event: Event) {
  draft.value = (event.target as HTMLInputElement).value;
  const parsed = parsedTime(draft.value);
  if (parsed) model.value = parsed;
}

function commitDraft() {
  const parsed = parsedTime(draft.value);
  if (parsed) model.value = parsed;
  draft.value = validTime(model.value);
}

function selectHour(value: string) {
  model.value = `${value}:${minute.value}`;
}

function selectMinute(value: string) {
  model.value = `${hour.value}:${value}`;
  open.value = false;
}

function stepTime(delta: number) {
  const totalMinutes = (Number(hour.value) * 60 + Number(minute.value) + delta + 24 * 60) % (24 * 60);
  model.value = `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}
</script>

<style scoped>
.control-plane-time-picker {
  display:grid;
  width:100%;
  min-width:0;
  height:36px;
  grid-template-columns:minmax(0,1fr) 34px;
  overflow:hidden;
  border:1px solid var(--control-plane-select-border);
  border-radius:6px;
  background:var(--control-plane-select-bg);
  color:var(--control-plane-select-text);
}
.control-plane-time-picker:focus-within { box-shadow:0 0 0 1px hsl(var(--ring)); }
.control-plane-time-picker-input { min-width:0; border:0; outline:0; background:transparent; color:inherit; font-size:13px; font-variant-numeric:tabular-nums; padding:0 9px; }
.control-plane-time-picker-trigger { display:flex; align-items:center; justify-content:center; border:0; border-left:1px solid var(--control-plane-select-border); background:transparent; color:var(--text-muted); cursor:pointer; }
.control-plane-time-picker-trigger:hover,.control-plane-time-picker-trigger[data-state="open"] { background:var(--surface-hover); color:var(--text-strong); }
:global(.control-plane-time-picker-popover) { width:min(224px,var(--reka-popover-content-available-width)); max-height:min(280px,var(--reka-popover-content-available-height)); overflow:hidden; border-color:var(--control-plane-select-content-border); background:var(--control-plane-select-content-bg); color:var(--control-plane-select-content-text); }
:global(.control-plane-time-picker-columns) { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); }
:global(.control-plane-time-picker-column) { display:grid; min-width:0; grid-template-rows:32px minmax(0,1fr); }
:global(.control-plane-time-picker-column + .control-plane-time-picker-column) { border-left:1px solid var(--line); }
:global(.control-plane-time-picker-column > span) { display:flex; align-items:center; justify-content:center; border-bottom:1px solid var(--line); color:var(--text-muted); font-size:12px; }
:global(.control-plane-time-picker-scroll) { height:min(220px,calc(var(--reka-popover-content-available-height) - 34px)); }
:global(.control-plane-time-picker-scroll [data-task-handoff-scroll-viewport]) { padding-right:7px; }
:global(.control-plane-time-picker-options) { display:grid; gap:2px; padding:3px; }
:global(.control-plane-time-picker-options button) { height:30px; border:0; border-radius:4px; background:transparent; color:var(--text); cursor:pointer; font-size:13px; font-variant-numeric:tabular-nums; }
:global(.control-plane-time-picker-options button:hover) { background:var(--surface-hover); }
:global(.control-plane-time-picker-options button.selected) { background:var(--surface-active); color:var(--text-strong); }
</style>
