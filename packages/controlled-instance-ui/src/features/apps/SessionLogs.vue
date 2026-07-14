<template>
  <div class="logs-panel">
    <div class="logs-meta">{{ logs.data.value?.logDir || session.paths.logDir }}</div>
    <div v-if="logs.isLoading.value" class="logs-empty">Loading logs...</div>
    <div v-else-if="!logs.data.value?.files.length" class="logs-empty">No log files yet.</div>
    <section v-for="file in logs.data.value?.files || []" v-else :key="file.name" class="log-file">
      <header>
        <strong>{{ file.name }}</strong>
        <span>{{ formatSize(file.size) }} · {{ file.updatedAt }}<template v-if="file.truncated"> · tail</template></span>
      </header>
      <ScrollArea class="log-file-content">
        <pre>{{ file.content || "(empty)" }}</pre>
      </ScrollArea>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { AppSession } from "../../api/types";
import { useAppSessionLogsQuery } from "../../api/queries";
import { ScrollArea } from "../../components/ui/scroll-area";

const props = defineProps<{ session: AppSession }>();
const logs = useAppSessionLogsQuery(props.session.id);

function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<style src="../../styles/features/logs.css"></style>
