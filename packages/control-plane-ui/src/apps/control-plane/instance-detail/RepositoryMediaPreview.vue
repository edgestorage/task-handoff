<template>
  <section class="repository-media-preview" :data-kind="kind">
    <div class="repository-media-toolbar">
      <span>{{ path.split('/').at(-1) }}</span>
      <Button as-child variant="ghost" size="sm"><a :href="src" :download="path.split('/').at(-1)"><Download :size="14" />{{ t("repository.workspace.download") }}</a></Button>
    </div>
    <ScrollArea type="always" class="repository-media-scroll">
      <div class="repository-media-content">
        <div v-if="failed || kind === 'download'" class="repository-media-state" role="status">
          <FileWarning :size="32" aria-hidden="true" />
          <span>{{ t(failed ? "repository.workspace.previewFailed" : "repository.workspace.previewUnavailable") }}</span>
          <span>{{ t("repository.workspace.downloadHint") }}</span>
        </div>
        <img v-else-if="kind === 'image'" :src="src" :alt="path" @error="failed = true" />
        <video v-else-if="kind === 'video'" :src="src" :aria-label="path" controls playsinline preload="metadata" @error="failed = true" />
        <audio v-else-if="kind === 'audio'" :src="src" :aria-label="path" controls preload="metadata" @error="failed = true" />
        <iframe v-else-if="kind === 'pdf'" :src="src" :title="path" @error="failed = true" />
      </div>
    </ScrollArea>
  </section>
</template>

<script setup lang="ts">
import { Download, FileWarning } from "@lucide/vue";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { RepositoryMediaKind } from "./repositoryPreview";

const props = defineProps<{ kind: RepositoryMediaKind; path: string; src: string }>();
const { t } = useI18n();
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });
</script>

<style scoped>
.repository-media-preview { display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); }
.repository-media-toolbar { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line-subtle); padding: 4px 12px; font-size: 12px; }
.repository-media-toolbar > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repository-media-toolbar :deep(a) { gap: 6px; flex: 0 0 auto; font-size: 12px; font-weight: 400; }
.repository-media-scroll { min-width: 0; min-height: 0; }
.repository-media-scroll :deep([data-task-handoff-scroll-viewport] > div) { height: 100%; }
.repository-media-content { display: flex; height: 100%; min-width: 0; min-height: 100%; align-items: center; justify-content: center; padding: 16px; }
.repository-media-content > img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.repository-media-content > video { display: block; width: 100%; max-height: 100%; }
.repository-media-content > audio { width: min(480px, 100%); }
.repository-media-content > iframe { width: 100%; height: 100%; min-height: 400px; border: 0; background: var(--surface); }
.repository-media-preview[data-kind="pdf"] .repository-media-content { height: 100%; padding: 0; }
.repository-media-state { display: grid; justify-items: center; gap: 8px; color: var(--text-muted); padding: 24px; font-size: 12px; text-align: center; }
</style>
