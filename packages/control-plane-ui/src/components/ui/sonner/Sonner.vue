<script lang="ts" setup>
import type { ToasterProps } from "vue-sonner"
import { reactiveOmit, useMutationObserver } from "@vueuse/core"
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, Loader2Icon, TriangleAlertIcon, XIcon } from "@lucide/vue"
import { ref } from "vue"
import { Toaster as Sonner } from "vue-sonner"
import "vue-sonner/style.css"

const props = defineProps<ToasterProps>()
const delegatedProps = reactiveOmit(props, "toastOptions")
const resolvedTheme = ref<"light" | "dark">("light")

function syncTheme() {
  resolvedTheme.value = document.documentElement.classList.contains("dark") ? "dark" : "light"
}

syncTheme()
useMutationObserver(document.documentElement, syncTheme, { attributes: true, attributeFilter: ["class", "data-theme"] })
</script>

<template>
  <Sonner
    class="toaster group"
    :toast-options="{
      unstyled: true,
      classes: {
        toast: 'task-handoff-toast',
        title: 'task-handoff-toast-title',
        description: 'task-handoff-toast-description',
        icon: 'task-handoff-toast-icon',
        closeButton: 'task-handoff-toast-close',
        actionButton: 'task-handoff-toast-action',
        cancelButton: 'task-handoff-toast-cancel',
        success: 'is-success',
        error: 'is-error',
        warning: 'is-warning',
        info: 'is-info',
      },
    }"
    v-bind="delegatedProps"
    :theme="props.theme ?? resolvedTheme"
  >
    <template #success-icon>
      <CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <CircleAlertIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <Loader2Icon class="size-4 animate-spin" />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>

<style>
.toaster[data-sonner-toaster][data-y-position="top"] {
  top: 68px;
}

.toaster[data-sonner-toaster][data-x-position="right"] {
  right: 18px;
}

.task-handoff-toast[data-sonner-toast] {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  width: min(420px, calc(100vw - 36px));
  min-height: 48px;
  border: 1px solid var(--line-strong) !important;
  border-left: 3px solid var(--brand-accent);
  border-radius: 8px;
  background: var(--surface-overlay) !important;
  color: var(--text-strong) !important;
  box-shadow: var(--shadow-popover);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  padding: 12px 12px 12px 14px;
}

.task-handoff-toast[data-sonner-toast].is-success { border-left: 3px solid var(--status-success) !important; }
.task-handoff-toast[data-sonner-toast].is-error { border-left: 3px solid var(--status-danger) !important; }
.task-handoff-toast[data-sonner-toast].is-warning { border-left: 3px solid var(--status-warning) !important; }

.task-handoff-toast-icon { color: var(--brand-accent); margin-top: 1px; }
.task-handoff-toast [data-content] { grid-column: 2; min-width: 0; }
.task-handoff-toast.is-success .task-handoff-toast-icon { color: var(--status-success); }
.task-handoff-toast.is-error .task-handoff-toast-icon { color: var(--status-danger); }
.task-handoff-toast.is-warning .task-handoff-toast-icon { color: var(--status-warning); }
.task-handoff-toast-title { color: var(--text-strong) !important; }
.task-handoff-toast-description { color: var(--text-muted) !important; font-weight: 500; }

.task-handoff-toast-close,
.task-handoff-toast-action,
.task-handoff-toast-cancel {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
}

.task-handoff-toast-close {
  display: grid;
  grid-column: 3;
  grid-row: 1;
  width: 26px;
  height: 26px;
  place-items: center;
  padding: 0;
}

.task-handoff-toast-close:hover,
.task-handoff-toast-action:hover,
.task-handoff-toast-cancel:hover {
  border-color: var(--line-strong);
  background: var(--surface-hover);
  color: var(--text-strong);
}
</style>
