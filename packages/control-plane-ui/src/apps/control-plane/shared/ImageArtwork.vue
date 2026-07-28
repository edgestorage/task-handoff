<template>
  <div class="image-artwork" :class="{ 'image-artwork--compact': compact }" role="img" :aria-label="name">
    <img v-if="remoteCover && !coverFailed" :src="remoteCover" alt="" @error="coverFailed = true" />
    <div class="image-artwork-glow" />
    <div class="image-artwork-mark">
      <Box :size="iconSize" :stroke-width="1.8" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Box } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import type { ImageCover } from "../../../api/types";

const props = withDefaults(defineProps<{
  cover?: ImageCover;
  compact?: boolean;
  iconSize?: number;
  name: string;
}>(), {
  cover: undefined,
  compact: false,
  iconSize: 28,
});

const coverFailed = ref(false);
const remoteCover = computed(() => props.cover?.kind === "remote" ? props.cover.url : "");
watch(remoteCover, () => { coverFailed.value = false; });
</script>

<style scoped>
.image-artwork {
  position: relative;
  isolation: isolate;
  min-height: 72px;
  overflow: hidden;
  border-radius: inherit;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--artwork-accent) 24%, transparent), transparent 58%),
    linear-gradient(135deg, #172a30, #0b1519 72%);
  color: color-mix(in srgb, var(--artwork-accent) 76%, white);
  --artwork-accent: #55d7c8;
}

.image-artwork::before,
.image-artwork::after {
  position: absolute;
  content: "";
  pointer-events: none;
}

.image-artwork::before {
  inset: 0;
  opacity: 0.28;
  background-image:
    linear-gradient(color-mix(in srgb, var(--artwork-accent) 16%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--artwork-accent) 16%, transparent) 1px, transparent 1px);
  background-size: 24px 24px;
  mask-image: linear-gradient(to right, black, transparent 72%);
}

.image-artwork::after {
  inset: auto 12px 12px auto;
  width: 34%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--artwork-accent));
  box-shadow: 0 -7px 0 color-mix(in srgb, var(--artwork-accent) 35%, transparent);
}

.image-artwork img {
  position: absolute;
  z-index: 3;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-artwork-glow {
  position: absolute;
  z-index: -1;
  top: -42%;
  left: -12%;
  width: 70%;
  aspect-ratio: 1;
  border-radius: 999px;
  background: color-mix(in srgb, var(--artwork-accent) 22%, transparent);
  filter: blur(24px);
}

.image-artwork-mark {
  position: absolute;
  left: 18px;
  top: 50%;
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  transform: translateY(-50%);
  border: 1px solid color-mix(in srgb, var(--artwork-accent) 42%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, #071014 70%, transparent);
  box-shadow: 0 12px 28px rgb(0 0 0 / 24%);
}

.image-artwork--compact .image-artwork-mark {
  top: 50%;
  left: 50%;
  width: 100%;
  height: 100%;
  transform: translate(-50%, -50%);
  border-color: color-mix(in srgb, var(--artwork-accent) 42%, var(--line));
  border-radius: inherit;
  background: #0b181c;
  box-shadow: none;
}

.image-artwork--compact {
  min-height: 0;
  background: #0b181c;
}

.image-artwork--compact::before,
.image-artwork--compact .image-artwork-glow,
.image-artwork--compact::after {
  display: none;
}
</style>
