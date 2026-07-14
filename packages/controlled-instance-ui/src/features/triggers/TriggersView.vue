<template>
  <section class="panel triggers-view">
    <header class="triggers-head">
      <div>
        <h1>Triggers</h1>
        <p>{{ triggers.data.value?.configs.length || 0 }} configs · {{ triggers.data.value?.deployments.length || 0 }} deployments</p>
      </div>
    </header>

    <div class="triggers-layout">
      <Card>
        <CardHeader>
          <CardTitle>Create Local Trigger</CardTitle>
          <CardDescription>Triggers send prompts directly to an AI session.</CardDescription>
        </CardHeader>
        <CardContent class="trigger-form">
          <label class="field-row">
            <span>Name</span>
            <Input v-model="form.name" placeholder="Review changed files" />
          </label>
          <label class="field-row">
            <span>Source</span>
            <Select v-model="form.sourceType"><SelectTrigger class="select-input"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="schedule">schedule</SelectItem><SelectItem value="file-change">file-change</SelectItem><SelectItem value="ai-session">ai-session</SelectItem></SelectContent></Select>
          </label>
          <label v-if="form.sourceType === 'schedule'" class="field-row">
            <span>Interval ms</span>
            <Input v-model="form.intervalMs" inputmode="numeric" />
          </label>
          <label v-if="form.sourceType === 'file-change'" class="field-row">
            <span>Roots</span>
            <Input v-model="form.roots" placeholder="/workspace" />
          </label>
          <label v-if="form.sourceType === 'file-change'" class="field-row">
            <span>Globs</span>
            <Input v-model="form.globs" placeholder="**/*" />
          </label>
          <label v-if="form.sourceType === 'ai-session'" class="field-row">
            <span>Status</span>
            <Input v-model="form.statuses" placeholder="idle,failed" />
          </label>
          <label class="field-row">
            <span>AI session</span>
            <Select v-model="form.aiSessionId">
              <SelectTrigger class="select-input"><SelectValue placeholder="Select a session" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="session in aiSessions.data.value?.sessions || []" :key="session.id" :value="session.id">
                  {{ session.title || session.id }} · {{ session.agent }}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label class="field-row trigger-wide">
            <span>Prompt</span>
            <Textarea v-model="form.promptTemplate" rows="8" />
          </label>
        </CardContent>
        <CardFooter class="editor-actions">
          <p v-if="createError" class="form-error">{{ createError }}</p>
          <Button size="sm" :disabled="!form.aiSessionId" @click="createLocalTrigger">Create</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deployments</CardTitle>
          <CardDescription>{{ triggerError || "Local and Control Plane applied triggers on this instance." }}</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="triggerRows.length" class="trigger-list">
            <section v-for="row in triggerRows" :key="row.deployment.deploymentId || row.config.configHash" class="trigger-card">
              <header class="trigger-card-head">
                <div>
                  <div class="trigger-title">
                    {{ row.config.name }}
                    <Badge variant="secondary">{{ row.config.source.type }}</Badge>
                    <Badge>{{ row.deployment.origin }}</Badge>
                  </div>
                  <div class="trigger-meta">
                    <span>{{ shortHash(row.config.configHash) }}</span>
                    <span>{{ row.runtime?.status || (row.deployment.enabled ? "idle" : "disabled") }}</span>
                    <span>{{ targetText(row.deployment.target) }}</span>
                  </div>
                </div>
                <div class="trigger-actions">
                  <Button variant="outline" size="sm" @click="run(row.config.configHash)">Run</Button>
                  <Button v-if="row.deployment.enabled" variant="outline" size="sm" @click="disable(row.config.configHash)">Disable</Button>
                  <Button v-else variant="outline" size="sm" @click="enable(row.config.configHash)">Enable</Button>
                  <Button variant="outline" size="sm" @click="remove(row.config.configHash)">Delete</Button>
                </div>
              </header>
              <pre class="trigger-prompt">{{ row.config.action.promptTemplate }}</pre>
              <p v-if="row.runtime?.lastError" class="form-error">{{ row.runtime.lastError }}</p>
            </section>
          </div>
          <p v-else class="logs-empty">No triggers yet.</p>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Recent Runs</CardTitle>
        <CardDescription>{{ triggers.data.value?.recentRuns.length || 0 }} runs</CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="triggers.data.value?.recentRuns.length" class="trigger-run-list">
          <div v-for="run in triggers.data.value.recentRuns" :key="run.id" class="trigger-run-row">
            <Badge :variant="run.status === 'failed' ? 'destructive' : 'secondary'">{{ run.status }}</Badge>
            <span>{{ shortHash(run.configHash) }}</span>
            <span>{{ run.eventType }}</span>
            <span>{{ formatDate(run.startedAt) }}</span>
            <span v-if="run.error" class="form-error">{{ run.error }}</span>
          </div>
        </div>
        <p v-else class="logs-empty">No trigger runs yet.</p>
      </CardContent>
    </Card>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { computed, reactive, ref } from "vue";
import { createTrigger, deleteTrigger, disableTrigger, enableTrigger, runTrigger, useAiSessionsQuery, useTriggersQuery } from "../../api/queries";
import type { TriggerConfig, TriggerDeployment, TriggerRuntimeState, TriggerSource, TriggerTarget } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";

const queryClient = useQueryClient();
const triggers = useTriggersQuery();
const aiSessions = useAiSessionsQuery();
const createError = ref("");

const form = reactive({
  name: "",
  sourceType: "schedule" as TriggerSource["type"],
  intervalMs: "3600000",
  roots: "/workspace",
  globs: "**/*",
  statuses: "idle,failed",
  aiSessionId: "",
  promptTemplate: "Please review the current context and continue with the next useful step.",
});

const triggerError = computed(() => (triggers.error.value instanceof Error ? triggers.error.value.message : ""));

type TriggerRow = { config: TriggerConfig; deployment: TriggerDeployment; runtime: TriggerRuntimeState | undefined };

const triggerRows = computed(() => {
  const index = triggers.data.value;
  if (!index) {
    return [] as TriggerRow[];
  }
  return index.deployments
    .map((deployment) => ({
      deployment,
      config: index.configs.find((item) => item.configHash === deployment.configHash),
      runtime: index.runtime.find((item) => item.configHash === deployment.configHash && (item.deploymentId || item.configHash) === (deployment.deploymentId || deployment.configHash)),
    }))
    .filter((row): row is TriggerRow => Boolean(row.config));
});

function sourceFromForm(): TriggerSource {
  if (form.sourceType === "file-change") {
    return {
      type: "file-change",
      roots: splitList(form.roots),
      globs: splitList(form.globs),
      debounceMs: 1500,
    };
  }
  if (form.sourceType === "ai-session") {
    return {
      type: "ai-session",
      statuses: splitList(form.statuses) as TriggerSource extends { statuses?: infer T } ? T : never,
    };
  }
  return {
    type: "schedule",
    intervalMs: Math.max(1000, Number(form.intervalMs) || 3600000),
  };
}

function targetFromForm(): TriggerTarget {
  if (!form.aiSessionId) {
    throw new Error("Select an AI session target.");
  }
  return { type: "ai-session", aiSessionId: form.aiSessionId };
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["triggers"] });
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function createLocalTrigger() {
  createError.value = "";
  try {
    await createTrigger({
      name: form.name.trim() || "Untitled trigger",
      source: sourceFromForm(),
      action: { promptTemplate: form.promptTemplate },
      policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
      deployment: { origin: "controlled-instance", target: targetFromForm() },
    });
    form.name = "";
    await refresh();
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error);
  }
}

async function run(configHash: string) {
  await runTrigger(configHash);
  await refresh();
}

async function enable(configHash: string) {
  await enableTrigger(configHash);
  await refresh();
}

async function disable(configHash: string) {
  await disableTrigger(configHash);
  await refresh();
}

async function remove(configHash: string) {
  await deleteTrigger(configHash);
  await refresh();
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

function targetText(target: TriggerTarget) {
  return `AI session ${target.aiSessionId}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<style src="../../styles/features/triggers.css"></style>
