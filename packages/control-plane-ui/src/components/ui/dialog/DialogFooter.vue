<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{ class?: HTMLAttributes["class"] }>()
</script>

<template>
  <div
    :class="cn(
      'flex flex-col-reverse [&_button]:h-8 [&_button]:rounded-md [&_button]:px-3 [&_button]:py-0 [&_button]:text-xs sm:flex-row sm:justify-end sm:gap-2',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
