<template>
  <input v-bind="$attrs" v-model="model" class="control-plane-input" />
</template>

<script setup lang="ts">
defineOptions({
  inheritAttrs: false,
});

const model = defineModel<string>({ default: "" });
</script>

<style scoped>
.control-plane-input {
  width: 100%;
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: 13px;
  padding: 0 9px;
}

.control-plane-input::placeholder {
  color: var(--text-subtle);
}
</style>
