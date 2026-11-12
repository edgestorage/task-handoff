<template>
  <article class="session-remote-desktop-card" :class="{ 'is-expanded': presentation === 'expanded' && expanded }">
    <button
      type="button"
      class="session-remote-desktop-card-main"
      :aria-expanded="presentation === 'expanded' ? expanded : undefined"
      :aria-label="mainLabel"
      @click="$emit('preview')"
    >
      <span class="session-remote-desktop-card-icon" aria-hidden="true"><Monitor :size="17" /></span>
      <span class="session-remote-desktop-card-copy">
        <strong>{{ title }}</strong>
        <small>{{ t("instances.remoteDesktop.lastOpened") }}<template v-if="detail"> · {{ detail }}</template></small>
      </span>
    </button>
    <button type="button" class="session-remote-desktop-card-action" :title="t('instances.remoteDesktop.openDetails')" :aria-label="t('instances.remoteDesktop.openDetails')" @click="$emit('details')">
      <ExternalLink :size="16" />
    </button>
    <button type="button" class="session-remote-desktop-card-action" :title="t('instances.remoteDesktop.removeFromSession')" :aria-label="t('instances.remoteDesktop.removeFromSession')" @click="$emit('remove')">
      <X :size="16" />
    </button>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ExternalLink, Monitor, X } from "@lucide/vue";
import type { SessionRemoteDesktopTarget } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts";

const props = defineProps<{
  expanded?: boolean;
  presentation?: "floating" | "expanded";
  target: SessionRemoteDesktopTarget;
}>();

defineEmits<{
  details: [];
  preview: [];
  remove: [];
}>();

const { t } = useI18n();
const title = computed(() => props.target.title || props.target.kind);
const detail = computed(() => props.target.subtitle || (props.target.width && props.target.height ? `${props.target.width} × ${props.target.height}` : ""));
const mainLabel = computed(() => props.presentation === "expanded"
  ? t(props.expanded ? "instances.remoteDesktop.collapsePreview" : "instances.remoteDesktop.expandPreview")
  : t("instances.remoteDesktop.openPreview", { title: title.value }));
</script>

<style scoped>
.session-remote-desktop-card {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 5px 7px 5px 0;
  border: 1px solid var(--line-subtle);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: 0 2px 10px rgb(0 0 0 / 5%);
}

.session-remote-desktop-card.is-expanded {
  border-bottom-right-radius: 0;
  border-bottom-left-radius: 0;
  border-bottom-color: transparent;
}

.session-remote-desktop-card-main {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 11px;
  padding: 7px 4px 7px 10px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: inherit;
  text-align: left;
}

.session-remote-desktop-card-main:hover,
.session-remote-desktop-card-main:focus-visible,
.session-remote-desktop-card-action:hover,
.session-remote-desktop-card-action:focus-visible {
  background: var(--surface-hover);
}

.session-remote-desktop-card-icon {
  display: inline-flex;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}

.session-remote-desktop-card-copy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.session-remote-desktop-card-copy strong,
.session-remote-desktop-card-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-remote-desktop-card-copy strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.session-remote-desktop-card-copy small {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}

.session-remote-desktop-card-action {
  display: inline-flex;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-muted);
}

.session-remote-desktop-card-main:focus-visible,
.session-remote-desktop-card-action:focus-visible {
  outline: 2px solid var(--brand-accent);
  outline-offset: 1px;
}
</style>
