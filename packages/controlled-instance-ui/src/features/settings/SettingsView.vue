<template>
  <section class="panel">
    <h1>Settings</h1>
    <div class="settings-layout">
      <Card>
        <CardHeader>
          <CardTitle>Main Config</CardTitle>
          <CardDescription>Global values still stored in the task-handoff config file.</CardDescription>
        </CardHeader>
        <CardContent class="settings-form">
          <label class="field-row">
            <span>Default Conversation ID</span>
            <Input v-model="defaultConversationId" inputmode="numeric" placeholder="1" />
          </label>
          <div class="settings-meta">
            <span>Next conversation: {{ settings.data.value?.nextConversationId || "-" }}</span>
            <span>Conversations: {{ conversations.length }}</span>
          </div>
        </CardContent>
        <CardFooter class="settings-actions">
          <p v-if="saveMessage" class="save-ok">{{ saveMessage }}</p>
          <p v-if="saveError" class="form-error">{{ saveError }}</p>
          <Button size="sm" :disabled="saving" @click="saveMainConfig">{{ saving ? "Saving" : "Save" }}</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conversations</CardTitle>
          <CardDescription>Read-only snapshot of conversation state in the main config.</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="conversations.length" class="conversation-list">
            <div v-for="conversation in conversations" :key="String(conversation.id)" class="conversation-row">
              <div>
                <div class="conversation-title">
                  #{{ conversation.id }}
                  <Badge v-if="String(conversation.id) === String(settings.data.value?.defaultConversationId || '')">default</Badge>
                </div>
                <div class="conversation-meta">
                  <span>{{ conversation.mode || "passive" }}</span>
                  <span>{{ conversation.status || "open" }}</span>
                  <span v-if="conversation.agent">agent: {{ conversation.agent }}</span>
                  <span v-if="conversation.timeoutMs">timeout: {{ formatTimeout(conversation.timeoutMs) }}</span>
                </div>
              </div>
              <div class="conversation-cwd">{{ conversation.cwd || "-" }}</div>
            </div>
          </div>
          <p v-else class="logs-empty">No conversations have been persisted yet.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Raw Preview</CardTitle>
          <CardDescription>Use domain pages for channels and apps; this preview is intentionally read-only.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea :model-value="settingsPreview" class="settings-json" readonly spellcheck="false" />
        </CardContent>
      </Card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { saveSettings, useSettingsQuery } from "../../api/queries";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";

const queryClient = useQueryClient();
const settings = useSettingsQuery();
const defaultConversationId = ref("");
const saving = ref(false);
const saveMessage = ref("");
const saveError = ref("");

const conversations = computed(() => settings.data.value?.conversations || []);
const settingsPreview = computed(() => JSON.stringify(settings.data.value || {}, null, 2));

watch(
  () => settings.data.value?.defaultConversationId,
  (value) => {
    defaultConversationId.value = value ? String(value) : "";
  },
  { immediate: true },
);

function formatTimeout(value: number | string) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return String(value);
  }
  if (timeoutMs < 60_000) {
    return `${Math.round(timeoutMs / 1000)}s`;
  }
  return `${Math.round(timeoutMs / 60_000)}m`;
}

async function saveMainConfig() {
  saveMessage.value = "";
  saveError.value = "";
  const id = Number(defaultConversationId.value);
  if (!Number.isInteger(id) || id <= 0) {
    saveError.value = "Default Conversation ID must be a positive integer.";
    return;
  }
  saving.value = true;
  try {
    await saveSettings({ defaultConversationId: id });
    await queryClient.invalidateQueries({ queryKey: ["settings"] });
    await queryClient.invalidateQueries({ queryKey: ["status"] });
    saveMessage.value = "Saved";
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}
</script>

<style src="../../styles/features/settings/settings-view.css"></style>
