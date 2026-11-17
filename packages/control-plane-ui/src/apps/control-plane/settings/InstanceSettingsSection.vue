<template>
  <ScrollArea class="instance-settings-scroll settings-page-scroll" :horizontal="false">
    <div class="instance-directory-page settings-content-page">
      <header class="instance-directory-page-head">
        <p>{{ t("settings.instanceRegistry.description") }}</p>
      </header>

      <div class="instance-directory-toolbar">
        <div class="instance-directory-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="search" type="search" :aria-label="t('settings.instanceRegistry.search')" :placeholder="t('settings.instanceRegistry.searchPlaceholder')" />
        </div>
        <ControlPlaneSelect v-model="nodeId" :aria-label="t('settings.instanceRegistry.nodeFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.instanceRegistry.allNodes") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="node in nodeOptions" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="status" :aria-label="t('settings.instanceRegistry.statusFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.instanceRegistry.allStatuses") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="value in statusOptions" :key="value" :value="value">{{ translateStatus(instanceStatusKeys, value, t) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="runtimeType" :aria-label="t('settings.instanceRegistry.runtimeFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.instanceRegistry.allRuntimes") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="value in runtimeOptions" :key="value" :value="value">{{ translateStatus(runtimeTypeKeys, value, t) }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <div v-if="unavailableNodes?.length" class="instance-directory-warning" role="status">
        <AlertTriangle :size="16" aria-hidden="true" />
        <span>{{ t("settings.instanceRegistry.unavailableNodes", { nodes: unavailableNodes.join(', ') }) }}</span>
        <Button variant="ghost" size="sm" @click="emit('retry')">{{ t("common.actions.retry") }}</Button>
      </div>

      <section class="instance-directory" :aria-label="t('settings.instanceRegistry.count', { count: filteredInstances.length })">
        <header class="instance-directory-head">
          <strong>{{ t("settings.instanceRegistry.count", { count: filteredInstances.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.instanceRegistry.filteredFrom", { count: instances.length }) }}</span>
          <Button v-if="hasActiveFilters" variant="ghost" size="sm" @click="clearFilters">{{ t("settings.instanceRegistry.clearFilters") }}</Button>
        </header>
        <div v-if="loading && !instances.length" class="instance-directory-state" role="status">{{ t("settings.instanceRegistry.loading") }}</div>
        <div v-else-if="errorMessage" class="instance-directory-state instance-directory-error" role="alert">
          <span>{{ errorMessage }}</span>
          <Button variant="outline" size="sm" @click="emit('retry')">{{ t("common.actions.retry") }}</Button>
        </div>
        <div v-else-if="!filteredInstances.length" class="instance-directory-state instance-directory-empty-state">
          <Boxes :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.instanceRegistry.noMatches") : t("settings.instanceRegistry.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.instanceRegistry.noMatchesDescription") : t("settings.instanceRegistry.emptyDescription") }}</p>
        </div>
        <div v-else class="instance-directory-list">
          <article v-for="instance in filteredInstances" :key="instance.id" class="instance-directory-row">
            <div class="instance-directory-identity">
              <strong>{{ instance.name }}</strong>
              <code :title="instance.id">{{ instance.id }}</code>
              <span v-if="instance.project?.name || instance.image?.name || instance.imageSnapshot?.name" class="instance-directory-environment">
                {{ [instance.project?.name, instance.image?.name || instance.imageSnapshot?.name].filter(Boolean).join(' · ') }}
              </span>
            </div>
            <div class="instance-directory-location">
              <span :title="nodeName(instance)"><Server :size="14" aria-hidden="true" /><span>{{ nodeName(instance) }}</span></span>
              <span v-if="instance.runtime" :title="instance.runtime.name"><Box :size="14" aria-hidden="true" /><span>{{ translateStatus(runtimeTypeKeys, instance.runtime.type, t) }} · {{ instance.runtime.name }}</span></span>
            </div>
            <div class="instance-directory-actions">
              <Badge :variant="instance.connectionStatus === 'online' && instance.node?.connectionEnabled !== false ? 'default' : 'secondary'">{{ instanceStatusBadgeLabel(instance, t) }}</Badge>
              <Button variant="outline" size="sm" :aria-label="t('settings.nodeDetail.instanceSettings', { name: instance.name })" @click="emit('openInstanceSettings', instance.id)">
                <Settings :size="14" aria-hidden="true" />
                <span>{{ t("settings.nodeDetail.settings") }}</span>
              </Button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { AlertTriangle, Box, Boxes, Search, Server, Settings } from "@lucide/vue";
import type { InstanceBoardItem, Node } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { instanceStatusKeys, runtimeTypeKeys, translateStatus } from "../../../i18n/status";
import { instanceStatusBadgeLabel } from "../useInstanceStatus";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { useInstanceSettingsDirectory } from "./useInstanceSettingsDirectory";

const props = defineProps<{
  instances: InstanceBoardItem[];
  nodes: Node[];
  loading?: boolean;
  errorMessage?: string;
  unavailableNodes?: string[];
}>();
const emit = defineEmits<{ openInstanceSettings: [instanceId: string]; retry: [] }>();
const { t } = useI18n();
const { search, nodeId, status, runtimeType, nodeName, nodeOptions, statusOptions, runtimeOptions, hasActiveFilters, filteredInstances, clearFilters } = useInstanceSettingsDirectory(() => props.instances, () => props.nodes);
</script>

<style scoped>
.instance-settings-scroll { height: 100%; min-height: 0; width: 100%; }
.instance-directory-page { display: grid; gap: 12px; }
.instance-directory-page-head { align-items: center; display: flex; }
.instance-directory-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; margin: 0; }
.instance-directory-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(220px, 1fr) repeat(3, minmax(130px, 160px)); }
.instance-directory-search { align-items: center; display: flex; min-width: 0; position: relative; }
.instance-directory-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.instance-directory-search :deep(input) { padding-left: 32px; }
.instance-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.instance-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px; min-height: 38px; padding: 4px 12px; }
.instance-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.instance-directory-head span { color: var(--text-muted); font-size: 12px; }
.instance-directory-head > button { margin-left: auto; }
.instance-directory-row { align-items: center; display: grid; gap: 16px; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto; padding: 12px; }
.instance-directory-row + .instance-directory-row { border-top: 1px solid var(--line); }
.instance-directory-identity, .instance-directory-location { display: grid; gap: 4px; min-width: 0; }
.instance-directory-identity strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.instance-directory-identity code, .instance-directory-environment, .instance-directory-location span { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.instance-directory-identity > *, .instance-directory-location > span > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.instance-directory-location > span { align-items: center; display: flex; gap: 6px; min-width: 0; }
.instance-directory-location svg { flex: none; }
.instance-directory-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.instance-directory-state { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; gap: 10px; justify-content: center; min-height: 160px; padding: 20px; }
.instance-directory-empty-state { align-content: center; display: grid; gap: 7px; justify-items: center; text-align: center; }
.instance-directory-empty-state strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.instance-directory-empty-state p { margin: 0; }
.instance-directory-error { color: var(--status-danger); flex-wrap: wrap; overflow-wrap: anywhere; }
.instance-directory-warning { align-items: center; border: 1px solid var(--line); border-radius: 8px; color: var(--status-warning); display: flex; font-size: 12px; gap: 8px; padding: 8px 12px; }
.instance-directory-warning > svg { flex: none; }
.instance-directory-warning > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 900px) {
  .instance-directory-toolbar { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .instance-directory-search { grid-column: 1 / -1; }
}
@media (max-width: 640px) {
  .instance-directory-toolbar, .instance-directory-row { grid-template-columns: minmax(0, 1fr); }
  .instance-directory-row { gap: 10px; }
  .instance-directory-actions { justify-content: flex-start; }
}
</style>
