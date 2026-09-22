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
