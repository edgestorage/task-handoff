<template>
  <section class="panel">
    <h1>Conversations</h1>
    <div class="conversations-layout">
      <Card>
        <CardHeader>
          <CardTitle>Create Conversation</CardTitle>
          <CardDescription v-if="conversations.data.value">Next ID: {{ conversations.data.value.nextConversationId }}</CardDescription>
        </CardHeader>
        <CardContent class="conversation-form">
          <label class="field-row">
            <span>Title</span>
            <Input v-model="createForm.title" placeholder="optional title" />
          </label>
          <label class="field-row">
            <span>Mode</span>
            <Select v-model="createForm.mode"><SelectTrigger class="select-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="passive">passive</SelectItem><SelectItem value="codex">codex</SelectItem><SelectItem value="claude">claude</SelectItem></SelectContent></Select>
          </label>
          <label class="field-row">
            <span>Working Directory</span>
            <Input v-model="createForm.cwd" placeholder="/workspace" />
          </label>
          <label class="field-row">
            <span>Timeout Minutes</span>
            <Input v-model="createForm.timeoutMinutes" inputmode="numeric" placeholder="60" />
          </label>
        </CardContent>
        <CardFooter class="editor-actions">
          <p v-if="createError" class="form-error">{{ createError }}</p>
          <Button size="sm" @click="createNewConversation">Create</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Index</CardTitle>
          <CardDescription>{{ conversations.data.value?.indexPath || "Conversation index will be created on first load." }}</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="conversations.data.value?.items.length" class="conversation-list">
            <section v-for="conversation in conversations.data.value.items" :key="conversation.id" class="conversation-card">
              <header class="conversation-card-header">
                <div>
                  <div class="conversation-title">
                    #{{ conversation.id }}
                    <span v-if="conversation.title">{{ conversation.title }}</span>
                    <Badge v-if="conversation.id === conversations.data.value.defaultConversationId">default</Badge>
                  </div>
                  <div class="conversation-meta">
                    <span>{{ conversation.mode }}</span>
                    <span>{{ conversation.status }}</span>
                    <span v-if="conversation.agent">agent: {{ conversation.agent }}</span>
                    <span v-if="conversation.timeoutMs">timeout: {{ formatTimeout(conversation.timeoutMs) }}</span>
                  </div>
                </div>
                <div class="conversation-actions">
                  <Button variant="outline" size="sm" @click="makeDefault(conversation.id)">Use</Button>
                  <Button v-if="conversation.status === 'open'" variant="outline" size="sm" @click="closeItem(conversation.id)">Close</Button>
                  <Button v-else variant="outline" size="sm" @click="reopenItem(conversation.id)">Reopen</Button>
                  <Button variant="outline" size="sm" @click="removeItem(conversation.id)">Delete</Button>
                </div>
              </header>

              <div class="conversation-edit-grid">
                <label class="field-row">
                  <span>Title</span>
                  <Input v-model="formFor(conversation).title" placeholder="optional title" />
                </label>
                <label class="field-row">
                  <span>Mode</span>
                  <Select v-model="formFor(conversation).mode"><SelectTrigger class="select-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="passive">passive</SelectItem><SelectItem value="codex">codex</SelectItem><SelectItem value="claude">claude</SelectItem></SelectContent></Select>
                </label>
                <label class="field-row conversation-wide-field">
                  <span>Working Directory</span>
                  <Input v-model="formFor(conversation).cwd" placeholder="/workspace" />
                </label>
                <label class="field-row">
                  <span>Timeout Minutes</span>
                  <Input v-model="formFor(conversation).timeoutMinutes" inputmode="numeric" placeholder="inherit" />
                </label>
                <label class="field-row">
                  <span>Agent Session</span>
                  <Input v-model="formFor(conversation).agentSessionId" placeholder="session id" />
                </label>
              </div>

              <footer class="conversation-card-footer">
                <span>{{ conversation.cwd || "-" }}</span>
                <div>
                  <span v-if="savedId === conversation.id" class="save-ok">Saved</span>
                  <span v-if="errorById[conversation.id]" class="form-error">{{ errorById[conversation.id] }}</span>
                  <Button size="sm" @click="saveItem(conversation)">Save</Button>
                </div>
              </footer>
            </section>
          </div>
          <p v-else class="logs-empty">No conversations yet.</p>
        </CardContent>
      </Card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { reactive, ref, watchEffect } from "vue";
import {
  closeConversation,
  createConversation,
  deleteConversation,
  reopenConversation,
  saveConversation,
  useConversation,
  useConversationsQuery,
} from "../../api/queries";
import type { ConversationPatch, ConversationRecord } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";

type ConversationForm = {
  title: string;
  mode: ConversationRecord["mode"];
  cwd: string;
  timeoutMinutes: string;
  agentSessionId: string;
};

const queryClient = useQueryClient();
const conversations = useConversationsQuery();
const createForm = reactive<ConversationForm>({ title: "", mode: "passive", cwd: "", timeoutMinutes: "", agentSessionId: "" });
const forms = reactive<Record<number, ConversationForm>>({});
const errorById = reactive<Record<number, string>>({});
const createError = ref("");
const savedId = ref<number | undefined>();

watchEffect(() => {
  for (const conversation of conversations.data.value?.items || []) {
    if (!forms[conversation.id]) {
      forms[conversation.id] = {
        title: conversation.title || "",
        mode: conversation.mode,
        cwd: conversation.cwd || "",
        timeoutMinutes: conversation.timeoutMs ? String(Math.round(conversation.timeoutMs / 60_000)) : "",
        agentSessionId: conversation.agentSessionId || conversation.codexSessionId || "",
      };
    }
  }
});

function formFor(conversation: ConversationRecord) {
  if (!forms[conversation.id]) {
    forms[conversation.id] = { title: "", mode: conversation.mode, cwd: "", timeoutMinutes: "", agentSessionId: "" };
  }
  return forms[conversation.id];
}

function formatTimeout(timeoutMs: number) {
  if (timeoutMs < 60_000) {
    return `${Math.round(timeoutMs / 1000)}s`;
  }
  return `${Math.round(timeoutMs / 60_000)}m`;
}

function patchFromForm(form: ConversationForm): ConversationPatch {
  const timeout = Number(form.timeoutMinutes);
  return {
    title: form.title.trim() || undefined,
    mode: form.mode,
    cwd: form.cwd.trim() || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout * 60_000) : undefined,
    agent: form.mode === "codex" || form.mode === "claude" ? form.mode : undefined,
    agentSessionId: form.agentSessionId.trim() || undefined,
  };
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["conversations"] });
  await queryClient.invalidateQueries({ queryKey: ["settings"] });
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function createNewConversation() {
  createError.value = "";
  try {
    await createConversation(patchFromForm(createForm));
    Object.assign(createForm, { title: "", mode: "passive", cwd: "", timeoutMinutes: "", agentSessionId: "" });
    await refresh();
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveItem(conversation: ConversationRecord) {
  savedId.value = undefined;
  errorById[conversation.id] = "";
  try {
    await saveConversation(conversation.id, patchFromForm(formFor(conversation)));
    savedId.value = conversation.id;
    await refresh();
  } catch (error) {
    errorById[conversation.id] = error instanceof Error ? error.message : String(error);
  }
}

async function makeDefault(id: number) {
  await useConversation(id);
  await refresh();
}

async function closeItem(id: number) {
  await closeConversation(id);
  await refresh();
}

async function reopenItem(id: number) {
  await reopenConversation(id);
  await refresh();
}

async function removeItem(id: number) {
  await deleteConversation(id);
  delete forms[id];
  await refresh();
}
</script>

<style src="../../styles/features/settings/conversations.css"></style>
