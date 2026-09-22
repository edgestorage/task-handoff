<template>
  <div class="session-tab-strip-frame">
    <div ref="viewport" class="session-tab-strip" @scroll="updateOverflow" @wheel="scrollWithWheel">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{ activeKey: string; itemCount: number }>();
const viewport = ref<HTMLElement>();
let observer: ResizeObserver | undefined;

function updateOverflow() {
  const element = viewport.value;
  if (!element) return;
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  element.dataset.overflowStart = String(element.scrollLeft > 1);
  element.dataset.overflowEnd = String(element.scrollLeft < maxScrollLeft - 1);
}

function revealActiveTab() {
  const element = viewport.value;
  const selected = element?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!element || !selected) return updateOverflow();
  const viewportBounds = element.getBoundingClientRect();
  const tabBounds = selected.getBoundingClientRect();
  if (tabBounds.left < viewportBounds.left) element.scrollLeft -= viewportBounds.left - tabBounds.left;
  else if (tabBounds.right > viewportBounds.right) element.scrollLeft += tabBounds.right - viewportBounds.right;
  updateOverflow();
}

function scrollWithWheel(event: WheelEvent) {
  const element = viewport.value;
  if (!element || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || element.scrollWidth <= element.clientWidth) return;
  const next = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + event.deltaY));
  if (next === element.scrollLeft) return;
  event.preventDefault();
  element.scrollLeft = next;
  updateOverflow();
}

function scrollAtPointer(clientX: number) {
  const element = viewport.value;
  if (!element || element.scrollWidth <= element.clientWidth) return;
  const bounds = element.getBoundingClientRect();
  const edge = Math.min(36, bounds.width / 4);
  const delta = clientX < bounds.left + edge ? -12 : clientX > bounds.right - edge ? 12 : 0;
  if (!delta) return;
  element.scrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + delta));
  updateOverflow();
}

onMounted(() => {
  const element = viewport.value;
  if (!element) return;
  observer = new ResizeObserver(revealActiveTab);
  observer.observe(element);
  if (element.firstElementChild instanceof HTMLElement) observer.observe(element.firstElementChild);
  revealActiveTab();
});
onBeforeUnmount(() => observer?.disconnect());
watch(() => [props.activeKey, props.itemCount], () => nextTick(revealActiveTab));

defineExpose({ scrollAtPointer });
</script>

<style>
.session-tab-strip-frame { position:relative; width:auto; min-width:0; max-width:100%; flex:0 1 auto; align-self:stretch; overflow:hidden; }
.session-tab-strip { width:100%; height:100%; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
.session-tab-strip::-webkit-scrollbar { display:none; }
.session-tab-strip[data-overflow-start="true"][data-overflow-end="false"] { -webkit-mask-image:linear-gradient(90deg,transparent,#000 28px); mask-image:linear-gradient(90deg,transparent,#000 28px); }
.session-tab-strip[data-overflow-start="false"][data-overflow-end="true"] { -webkit-mask-image:linear-gradient(270deg,transparent,#000 28px); mask-image:linear-gradient(270deg,transparent,#000 28px); }
.session-tab-strip[data-overflow-start="true"][data-overflow-end="true"] { -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 28px,#000 calc(100% - 28px),transparent 100%); mask-image:linear-gradient(90deg,transparent 0,#000 28px,#000 calc(100% - 28px),transparent 100%); }
.session-tab-strip-content { display:flex; align-items:center; gap:2px; height:100%; min-width:max-content; padding:0; }
.session-tab-sortable-shell { display:inline-flex; flex:0 0 auto; }
.session-tab-reorder-move { transition:transform 160ms cubic-bezier(.2,.8,.2,1); }
</style>
