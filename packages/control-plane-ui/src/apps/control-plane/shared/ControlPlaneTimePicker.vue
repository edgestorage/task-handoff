<template>
  <div class="control-plane-time-picker">
    <ControlPlaneSelect v-model="hour" :aria-label="hourLabel" trigger-class="control-plane-time-picker-segment">
      <ControlPlaneSelectItem v-for="option in hourOptions" :key="option" :value="option">{{ option }}</ControlPlaneSelectItem>
    </ControlPlaneSelect>
    <span class="control-plane-time-picker-separator" aria-hidden="true">:</span>
    <ControlPlaneSelect v-model="minute" :aria-label="minuteLabel" trigger-class="control-plane-time-picker-segment">
      <ControlPlaneSelectItem v-for="option in minuteOptions" :key="option" :value="option">{{ option }}</ControlPlaneSelectItem>
    </ControlPlaneSelect>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import ControlPlaneSelect from "./ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "./ControlPlaneSelectItem.vue";

defineProps<{
  hourLabel: string;
  minuteLabel: string;
}>();

const model = defineModel<string>({ default: "00:00" });
const hourOptions = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const minuteOptions = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

function timeParts() {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(model.value);
  return match ? { hour: match[1], minute: match[2] } : { hour: "00", minute: "00" };
}

const hour = computed({
  get: () => timeParts().hour,
  set: (value: string) => { model.value = `${value}:${timeParts().minute}`; },
});
const minute = computed({
  get: () => timeParts().minute,
  set: (value: string) => { model.value = `${timeParts().hour}:${value}`; },
});
</script>

<style scoped>
.control-plane-time-picker {
  display:grid;
  grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);
  align-items:center;
  gap:8px;
  width:100%;
}

.control-plane-time-picker-separator {
  color:var(--text-muted);
  font-size:13px;
}

:deep(.control-plane-time-picker-segment) {
  font-variant-numeric:tabular-nums;
}
</style>
