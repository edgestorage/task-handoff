<template>
  <slot
    :on-keydown="onKeydown"
  />
</template>

<script setup lang="ts">
export type ResourceTabStripItem = { key: string };

const props = defineProps<{
  items: ResourceTabStripItem[];
  activeKey: string;
}>();
const emit = defineEmits<{
  select: [key: string];
}>();

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || !props.items.length) return;
  const currentKey = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-resource-tab-key]")?.dataset.resourceTabKey || props.activeKey;
  const index = Math.max(0, props.items.findIndex((item) => item.key === currentKey));
  let nextIndex = index;
  if (event.key === "ArrowLeft") nextIndex = (index - 1 + props.items.length) % props.items.length;
  else if (event.key === "ArrowRight") nextIndex = (index + 1) % props.items.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = props.items.length - 1;
  else return;
  const item = props.items[nextIndex];
  if (!item) return;
  event.preventDefault();
  emit("select", item.key);
  requestAnimationFrame(() => {
    const list = (event.currentTarget as HTMLElement | null);
    list?.querySelector<HTMLElement>(`[data-resource-tab-key="${CSS.escape(item.key)}"]`)?.focus();
  });
}
</script>
