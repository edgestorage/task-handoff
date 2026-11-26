<script setup lang="ts">
import type { ScrollAreaRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  ScrollAreaCorner,
  ScrollAreaRoot,
  ScrollAreaViewport,
} from "reka-ui"
import { cn } from "@/lib/utils"
import ScrollBar from "./ScrollBar.vue"

const props = withDefaults(defineProps<ScrollAreaRootProps & {
  class?: HTMLAttributes["class"]
  horizontal?: boolean
  fadeTop?: boolean
}>(), {
  horizontal: true,
})

const delegatedProps = reactiveOmit(props, "class", "horizontal", "fadeTop")

function updateFade(event: Event) {
  const viewport = event.currentTarget as HTMLElement
  viewport.style.setProperty('--scroll-fade-top', `${Math.min(18, Math.max(0, viewport.scrollTop))}px`)
}
</script>

<template>
  <ScrollAreaRoot v-bind="delegatedProps" :class="cn('relative overflow-hidden', { 'fade-top': fadeTop }, props.class)">
    <ScrollAreaViewport data-task-handoff-scroll-viewport class="h-full w-full rounded-[inherit]" v-on="fadeTop ? { scroll: updateFade } : {}">
      <slot />
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollBar v-if="horizontal" orientation="horizontal" />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>

<style scoped>
.fade-top > :deep([data-task-handoff-scroll-viewport]) { mask-image:linear-gradient(to bottom, transparent, black var(--scroll-fade-top, 0px)); }
</style>
