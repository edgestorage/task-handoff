<template>
  <BaseEdge
    :id="id"
    :path="geometry.path"
    :marker-start="markerStart"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
  />
  <g
    v-if="removable"
    class="agent-graph-edge-remove"
    role="button"
    tabindex="0"
    :aria-label="removeLabel"
    :transform="`translate(${geometry.labelX},${geometry.labelY})`"
    @keydown.enter.prevent="emit('remove')"
    @keydown.space.prevent="emit('remove')"
  >
    <circle r="10" />
    <path d="M-3.4 -3.4 L3.4 3.4 M3.4 -3.4 L-3.4 3.4" />
  </g>
</template>

<script setup lang="ts">
// 自定义边：用 Vue Flow 的 BaseEdge 保留原来的贝塞尔路径、箭头与加宽的命中带，再在中点叠加删除按钮。
// 删除按钮必须留在边自身的 <g> 内：悬停按钮仍属于这条边，指针移向按钮时边不会触发 mouseleave，
// 按钮因此不会闪掉；同时它只是普通 SVG 元素，不需要额外的浮层与定位补偿。
import { computed } from "vue";
import { BaseEdge, Position, getBezierPath } from "@vue-flow/core";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: Position;
  targetPosition?: Position;
  markerStart?: string;
  markerEnd?: string;
  interactionWidth?: number;
  /** 离线节点上的关系只读，不提供删除入口。 */
  removable: boolean;
  removeLabel: string;
}>();

const emit = defineEmits<{ remove: [] }>();

const geometry = computed(() => {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition ?? Position.Bottom,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition ?? Position.Top,
  });
  return { path, labelX, labelY };
});
</script>

<style scoped>
.agent-graph-edge-remove { opacity:0; pointer-events:all; cursor:pointer; transition:opacity 120ms ease; }
.vue-flow__edge:hover .agent-graph-edge-remove,
.vue-flow__edge:focus-within .agent-graph-edge-remove,
.agent-graph-edge-remove:focus-visible { opacity:1; }
.agent-graph-edge-remove:focus-visible { outline:none; }
.agent-graph-edge-remove circle { fill:var(--surface); stroke:var(--line-strong); stroke-width:1; }
.agent-graph-edge-remove path { fill:none; stroke:var(--text-muted); stroke-width:1.5; stroke-linecap:round; }
.agent-graph-edge-remove:hover circle,
.agent-graph-edge-remove:focus-visible circle { stroke:var(--brand-accent); }
.agent-graph-edge-remove:hover path,
.agent-graph-edge-remove:focus-visible path { stroke:var(--brand-accent); }
</style>
