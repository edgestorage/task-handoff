<template>
  <span
    class="session-tab-item"
    :class="{ active, focused, 'drag-placeholder': dragPlaceholder }"
    role="tab"
    :tabindex="tabindex"
    :aria-selected="active"
    @click="$emit('select', $event)"
    @keydown.enter.prevent="$emit('select', $event)"
    @keydown.space.prevent="$emit('select', $event)"
  >
    <span class="session-tab-button">
      <slot name="icon" />
      <slot>
        <span class="session-tab-text">
          <strong>{{ label }}</strong>
        </span>
      </slot>
    </span>
    <button
      type="button"
      class="session-tab-close"
      :disabled="closing"
      :aria-label="closeLabel"
      :title="closeTitle"
      @click.stop="$emit('close')"
    >
      <X :size="13" />
    </button>
  </span>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue";

withDefaults(defineProps<{
  label: string;
  active?: boolean;
  focused?: boolean;
  dragPlaceholder?: boolean;
  closing?: boolean;
  closeLabel: string;
  closeTitle: string;
  tabindex?: number;
}>(), {
  active: false,
  focused: false,
  dragPlaceholder: false,
  closing: false,
  tabindex: 0,
});

defineEmits<{
  select: [event: MouseEvent | KeyboardEvent];
  close: [];
}>();
</script>

<style>
.session-tab-item {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex: 0 0 auto;
  min-width: 92px;
  max-width: 190px;
  min-height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: default;
  padding: 0 5px 0 9px;
  overflow: hidden;
  touch-action: none;
  transition:
    background-color 120ms ease,
    color 120ms ease,
    opacity 120ms ease;
  user-select: none;
}

.session-tab-item.drag-placeholder {
  border: 1px dashed color-mix(in srgb, var(--brand-accent) 58%, var(--line));
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
  color: transparent;
  opacity: 0.72;
  pointer-events: none;
}

.session-tab-item.drag-placeholder > * {
  visibility: hidden;
}

.session-tab-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  height: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0 1px 0 0;
}

.session-tab-item:not(.drag-placeholder):focus-within,
.session-tab-item:not(.drag-placeholder):hover,
.session-tab-item:not(.drag-placeholder):focus-visible {
  background: var(--surface-hover);
  outline: none;
}

.session-tab-item.active:not(.drag-placeholder) {
  background: var(--surface-active);
  color: var(--text-strong);
}

.session-tab-item[data-kind="repository"]:not(.drag-placeholder) {
  color: var(--text-muted);
}

.session-tab-item[data-kind="repository"]:not(.drag-placeholder):hover,
.session-tab-item[data-kind="repository"]:not(.drag-placeholder):focus-within,
.session-tab-item[data-kind="repository"]:not(.drag-placeholder):focus-visible,
.session-tab-item[data-kind="repository"].active:not(.drag-placeholder) {
  color: var(--text-strong);
}

.session-tab-item[data-kind="repository"] .session-tab-icon {
  color: inherit;
}

.session-tab-text {
  display: block;
  min-width: 0;
  text-align: left;
}

.session-tab-text strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: currentColor;
  font-size: 13px;
  font-weight: 400;
  line-height: 1;
}

.session-tab-icon {
  flex: 0 0 auto;
  color: var(--text-subtle);
}

.session-tab-icon-loading {
  animation: shared-session-tab-icon-spin 1s linear infinite;
}

@keyframes shared-session-tab-icon-spin {
  to { transform: rotate(360deg); }
}

.session-tab-item.active .session-tab-icon {
  color: currentColor;
}

.session-tab-close {
  display: grid;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  align-self: center;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-subtle);
  cursor: pointer;
  opacity: 0;
  padding: 0;
  pointer-events: none;
  transition:
    opacity 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}

.session-tab-item:hover .session-tab-close,
.session-tab-item:focus-within .session-tab-close,
.session-tab-item.active .session-tab-close {
  opacity: 1;
  pointer-events: auto;
}

.session-tab-close:hover,
.session-tab-close:focus-visible {
  background: var(--surface-hover);
  color: var(--text-strong);
  outline: none;
}

.session-tab-close:disabled {
  cursor: default;
  opacity: 0.5;
}

/* Shared chrome for tab strips that render the hover detail card and inline title editing. */
.session-tab-detail-tooltip {
  position: fixed;
  z-index: 9999;
  display: grid;
  gap: 6px;
  width: min(280px, calc(100vw - 32px));
  max-height: calc(100vh - 24px);
  border: 0;
  border-radius: 10px;
  background: var(--surface-hover) !important;
  color: var(--text-strong) !important;
  box-shadow: 0 14px 38px rgb(0 0 0 / 38%);
  overflow: auto;
  padding: 13px 14px;
  pointer-events: auto;
  -webkit-backdrop-filter: blur(16px) saturate(1.18);
  backdrop-filter: blur(16px) saturate(1.18);
  transition:
    left 120ms cubic-bezier(0.2, 0.8, 0.2, 1),
    top 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.session-tab-detail-enter-active,
.session-tab-detail-leave-active {
  transition:
    opacity 100ms ease,
    transform 100ms ease;
}

.session-tab-detail-enter-from,
.session-tab-detail-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.session-tab-detail-title {
  display: block;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.session-tab-detail-subtitle {
  display: block;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.session-tab-title-input {
  min-width: 0;
  width: 120px;
  border: 1px solid var(--brand-accent);
  border-radius: 4px;
  background: var(--surface-inset);
  color: var(--text-strong);
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 18px;
  outline: none;
  padding: 3px 5px;
}

.session-tab-title-input[aria-invalid="true"] {
  border-color: hsl(var(--destructive));
}

.session-tab-pointer-overlay {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 7px;
  top: 0;
  left: 0;
  overflow: hidden;
  max-width: 190px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 52%, var(--line));
  border-radius: 8px;
  background: var(--surface-raised);
  box-shadow: 0 10px 28px rgb(0 0 0 / 34%);
  color: var(--text-strong);
  cursor: default;
  font-size: 13px;
  padding: 0 10px;
  pointer-events: none;
  will-change: transform;
}

.session-tab-pointer-overlay strong {
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.session-tab-pointer-dragging {
  cursor: default;
  user-select: none;
}

body.session-tab-pointer-dragging iframe {
  pointer-events: none;
}

@media (max-width: 780px) {
  .session-tab-item {
    touch-action: pan-x;
    -webkit-touch-callout: none;
  }
}
</style>
