<template>
  <span class="ai-session-animated-text" :class="{ 'ai-session-animated-text-center': node.center }">
    <span v-if="settledContent">{{ settledContent }}</span>
    <span
      v-for="segment in pendingSegments"
      :key="segment.id"
      class="ai-session-animated-character"
      @animationend.stop="settleSegment(segment.id)"
    >{{ segment.text }}</span>
  </span>
</template>

<script setup lang="ts">
import type { Ref } from "vue";
import { computed, inject, onBeforeUnmount, ref, useAttrs, watch } from "vue";

const CHARACTER_FADE_MS = 150;

const props = defineProps<{
  node: {
    type: "text";
    content: string;
    raw: string;
    center?: boolean;
  };
}>();

type CharacterRevealCoordinator = {
  enabled: Readonly<Ref<boolean>>;
  begin: () => void;
  end: () => void;
};

type PendingSegment = {
  id: number;
  text: string;
  settled: boolean;
  counted: boolean;
};

const attrs = useAttrs();
const coordinator = inject<CharacterRevealCoordinator | undefined>("aiSessionCharacterReveal", undefined);
const sharedTextState = inject<Map<string, string> | undefined>("markstreamTextStreamState", undefined);
const streamStateKey = computed(() => String(attrs["index-key"] ?? attrs.indexKey ?? ""));
const settledContent = ref("");
const pendingSegments = ref<PendingSegment[]>([]);
const timers = new Map<number, number>();
let nextSegmentId = 0;
let activeKey = "";

function renderedContent() {
  return settledContent.value + pendingSegments.value.map((segment) => segment.text).join("");
}

function graphemes(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (entry) => entry.segment);
  }
  return Array.from(value);
}

function releaseSegment(segment: PendingSegment) {
  if (!segment.counted) return;
  segment.counted = false;
  coordinator?.end();
}

function clearPendingSegments() {
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
  for (const segment of pendingSegments.value) releaseSegment(segment);
  pendingSegments.value = [];
}

function appendCharacters(value: string) {
  if (!value) return;
  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion || (coordinator && !coordinator.enabled.value)) {
    settledContent.value += value;
    return;
  }

  const additions = graphemes(value).map((text) => {
    coordinator?.begin();
    return { id: ++nextSegmentId, text, settled: false, counted: Boolean(coordinator) };
  });
  pendingSegments.value = [...pendingSegments.value, ...additions];
  for (const segment of additions) {
    timers.set(segment.id, window.setTimeout(() => settleSegment(segment.id), CHARACTER_FADE_MS + 32));
  }
}

function drainSettledPrefix() {
  let count = 0;
  let text = "";
  while (count < pendingSegments.value.length && pendingSegments.value[count].settled) {
    text += pendingSegments.value[count].text;
    count += 1;
  }
  if (!count) return;
  settledContent.value += text;
  pendingSegments.value = pendingSegments.value.slice(count);
}

function settleSegment(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
  const segment = pendingSegments.value.find((candidate) => candidate.id === id);
  if (!segment || segment.settled) return;
  segment.settled = true;
  releaseSegment(segment);
  drainSettledPrefix();
}

watch(
  [() => props.node.content, streamStateKey],
  ([next, key]) => {
    const normalized = String(next ?? "");
    if (key !== activeKey) {
      clearPendingSegments();
      activeKey = key;
      const persisted = key ? sharedTextState?.get(key) : undefined;
      settledContent.value = persisted && normalized.startsWith(persisted) ? persisted : "";
    }

    const rendered = renderedContent();
    if (normalized.startsWith(rendered)) {
      appendCharacters(normalized.slice(rendered.length));
    } else if (normalized !== rendered) {
      clearPendingSegments();
      settledContent.value = normalized;
    }

    if (key) sharedTextState?.set(key, normalized);
  },
  { immediate: true },
);

onBeforeUnmount(clearPendingSegments);
</script>

<style scoped>
.ai-session-animated-text {
  display: inline;
  font-weight: inherit;
  vertical-align: baseline;
}

.ai-session-animated-text-center {
  display: inline-flex;
  justify-content: center;
  width: 100%;
}

.ai-session-animated-character {
  display: inline;
  animation: ai-session-character-fade 150ms ease-out both;
  will-change: opacity;
}

@keyframes ai-session-character-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-animated-character {
    animation: none;
  }
}
</style>
