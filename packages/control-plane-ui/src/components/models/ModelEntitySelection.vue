<template>
  <div class="model-entity-selection">
    <div v-if="selectedModels.length" class="model-entity-group">
      <div class="model-entity-group-heading">
        <strong>{{ t("instances.modelEntities.selected") }}</strong>
        <small>{{ t("instances.modelEntities.orderHint") }}</small>
      </div>
      <div class="model-entity-list" role="list">
        <article v-for="(model, index) in selectedModels" :key="model.id" class="model-entity-row" role="listitem">
          <span class="model-entity-order" aria-hidden="true">{{ index + 1 }}</span>
          <span class="model-entity-copy">
            <strong>{{ model.name }}</strong>
            <small>{{ modelDescription(model) }}</small>
          </span>
          <span class="model-entity-actions">
            <Button type="button" variant="ghost" size="icon-sm" :disabled="disabled || index === 0" :aria-label="t('instances.modelEntities.moveUp', { name: model.name })" @click="move(index, -1)">
              <ChevronUp :size="15" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" :disabled="disabled || index === selectedModels.length - 1" :aria-label="t('instances.modelEntities.moveDown', { name: model.name })" @click="move(index, 1)">
              <ChevronDown :size="15" />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" :disabled="disabled" :aria-label="t('instances.modelEntities.remove', { name: model.name })" @click="remove(model.id)">
              <X :size="15" />
            </Button>
          </span>
        </article>
      </div>
    </div>

    <div v-if="availableModels.length" class="model-entity-group model-entity-available">
      <div class="model-entity-group-heading">
        <strong>{{ t("instances.modelEntities.available") }}</strong>
        <small>{{ t("instances.modelEntities.availableHint") }}</small>
      </div>
      <div class="model-entity-list" role="list">
        <article v-for="model in availableModels" :key="model.id" class="model-entity-row" role="listitem">
          <span class="model-entity-copy">
            <strong>{{ model.name }}</strong>
            <small>{{ modelDescription(model) }}</small>
          </span>
          <Button type="button" variant="ghost" size="sm" :disabled="disabled" @click="add(model.id)">
            <Plus :size="15" />
            {{ t("instances.modelEntities.add") }}
          </Button>
        </article>
      </div>
    </div>

    <p v-if="!selectedModels.length && !availableModels.length" class="model-entity-empty">
      {{ t("instances.modelEntities.empty") }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, Plus, X } from "@lucide/vue";
import type { ModelConfig } from "../../api/types";
import { Button } from "../ui/button";

const props = defineProps<{
  modelValue: string[];
  models: ModelConfig[];
  nodeId: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const { t } = useI18n();

const eligibleModels = computed(() => props.models
  .filter((model) => model.enabled && model.locations?.some((location) => location.enabled && (location.type === "control-plane" || location.nodeId === props.nodeId)))
  .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
const modelById = computed(() => new Map(props.models.map((model) => [model.id, model])));
const selectedModels = computed(() => props.modelValue.map((id) => modelById.value.get(id)).filter((model): model is ModelConfig => Boolean(model)));
const selectedIds = computed(() => new Set(props.modelValue));
const availableModels = computed(() => eligibleModels.value.filter((model) => !selectedIds.value.has(model.id)));

function add(id: string) {
  if (!selectedIds.value.has(id)) emit("update:modelValue", [...props.modelValue, id]);
}

function remove(id: string) {
  emit("update:modelValue", props.modelValue.filter((candidate) => candidate !== id));
}

function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= props.modelValue.length) return;
  const next = [...props.modelValue];
  [next[index], next[target]] = [next[target], next[index]];
  emit("update:modelValue", next);
}

function modelDescription(model: ModelConfig) {
  const names = [...(model.modelNames?.length ? model.modelNames : [{ name: model.model, order: 0 }])]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((entry) => entry.name)
    .join(", ");
  return `${names} · ${(model.protocols || []).join(", ")}`;
}
</script>

<style scoped>
.model-entity-selection {
  display: grid;
}

.model-entity-group + .model-entity-group {
  border-top: 1px solid var(--line);
}

.model-entity-group-heading {
  display: grid;
  gap: 2px;
  padding: 12px 16px 8px;
}

.model-entity-group-heading strong,
.model-entity-copy strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.model-entity-group-heading small,
.model-entity-copy small,
.model-entity-empty {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
}

.model-entity-list {
  display: grid;
}

.model-entity-row {
  display: flex;
  min-width: 0;
  min-height: 54px;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 16px;
}

.model-entity-row + .model-entity-row {
  border-top: 1px solid var(--line);
}

.model-entity-order {
  display: grid;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 6px;
  background: var(--surface-active);
  color: var(--text-muted);
  font-size: 12px;
}

.model-entity-copy {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 2px;
}

.model-entity-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-entity-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}

.model-entity-empty {
  margin: 0;
  padding: 16px;
}

@media (max-width: 560px) {
  .model-entity-row {
    align-items: flex-start;
  }

  .model-entity-actions {
    align-self: center;
  }
}
</style>
