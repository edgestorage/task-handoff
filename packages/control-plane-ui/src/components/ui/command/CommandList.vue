<script setup lang="ts">
import type { ListboxContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ListboxContent, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"

const props = withDefaults(defineProps<ListboxContentProps & {
  class?: HTMLAttributes["class"]
  scrollable?: boolean
}>(), {
  scrollable: true,
})

const delegatedProps = reactiveOmit(props, "class", "scrollable")

const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <ListboxContent v-bind="forwarded" :class="cn(props.scrollable && 'max-h-[300px] overflow-y-auto overflow-x-hidden', props.class)">
    <div role="presentation">
      <slot />
    </div>
  </ListboxContent>
</template>
