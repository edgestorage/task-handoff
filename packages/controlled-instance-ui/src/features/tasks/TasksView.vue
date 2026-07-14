<template>
  <section class="panel">
    <h1>Tasks</h1>
    <dl class="task-summary">
      <div>
        <dt>Pending</dt>
        <dd>{{ tasks.data.value?.pending.length || 0 }}</dd>
      </div>
      <div>
        <dt>Queued Replies</dt>
        <dd>{{ tasks.data.value?.queuedReplies.length || 0 }}</dd>
      </div>
      <div>
        <dt>Approvals</dt>
        <dd>{{ approvalCount }}</dd>
      </div>
    </dl>
    <div class="tasks-layout">
      <Card>
        <CardHeader>
          <CardTitle>Pending</CardTitle>
          <CardDescription>{{ tasks.data.value?.pending.length || 0 }} waiting for a reply</CardDescription>
        </CardHeader>
        <CardContent>
          <p v-if="tasks.error.value" class="form-error">{{ errorText }}</p>
          <div v-else-if="tasks.data.value?.pending.length" class="task-list">
            <section v-for="task in tasks.data.value.pending" :key="task.id" class="task-card">
              <header class="task-header">
                <div>
                  <div class="task-title">
                    #{{ task.id }}
                    <Badge :variant="task.kind === 'approval' ? 'default' : 'secondary'">{{ task.kind || "task" }}</Badge>
                  </div>
                  <div class="task-meta">
                    <span>c{{ task.conversationId }}</span>
                    <span>{{ task.source || "cli" }}</span>
                    <span>timeout: {{ formatTimeout(task.timeoutMs) }}</span>
                    <span v-if="task.visibleConversationIds?.length">visible: {{ task.visibleConversationIds.join(", ") }}</span>
                  </div>
                </div>
                <div v-if="task.kind === 'approval'" class="task-actions">
                  <Button size="sm" @click="handleApproval(task.id, 'allow')">Allow</Button>
                  <Button variant="outline" size="sm" @click="handleApproval(task.id, 'skip')">Skip</Button>
                  <Button variant="outline" size="sm" @click="handleApproval(task.id, 'deny')">Deny</Button>
                </div>
                <div v-else class="task-actions">
                  <Button variant="outline" size="sm" @click="drop(task.id)">Drop</Button>
                </div>
              </header>

              <ScrollArea class="task-result-scroll">
                <pre class="task-result">{{ task.result }}</pre>
              </ScrollArea>

              <div v-if="task.attachments?.length" class="task-attachments">
                <Badge v-for="attachment in task.attachments" :key="attachment.id" variant="secondary">
                  {{ attachment.kind }}: {{ attachment.name }}
                </Badge>
              </div>

              <div v-if="task.kind !== 'approval'" class="task-reply">
                <Textarea v-model="replyForms[task.id]" placeholder="Markdown reply" />
                <Button size="sm" @click="reply(task.id)">Reply</Button>
              </div>
              <p v-if="errorById[task.id]" class="form-error">{{ errorById[task.id] }}</p>
            </section>
          </div>
          <p v-else class="logs-empty">No pending tasks.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Queued Replies</CardTitle>
          <CardDescription>{{ tasks.data.value?.queuedReplies.length || 0 }} replies waiting for matching sessions</CardDescription>
        </CardHeader>
        <CardContent>
          <div v-if="tasks.data.value?.queuedReplies.length" class="queued-list">
            <div v-for="queued in tasks.data.value.queuedReplies" :key="queued.id" class="queued-row">
              <header class="queued-header">
                <div class="task-title">
                  #{{ queued.id }}
                  <Badge variant="secondary">c{{ queued.conversationId }}</Badge>
                  <Badge v-if="queued.label" variant="secondary">{{ queued.label }}</Badge>
                </div>
              </header>
              <ScrollArea class="queued-value-scroll">
                <pre class="queued-value">{{ queued.value }}</pre>
              </ScrollArea>
            </div>
          </div>
          <p v-else class="logs-empty">No queued replies.</p>
        </CardContent>
      </Card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { computed, reactive } from "vue";
import { approveTask, denyTask, dropTask, replyTask, skipTask, usePendingTasksQuery } from "../../api/queries";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Textarea } from "../../components/ui/textarea";

const queryClient = useQueryClient();
const tasks = usePendingTasksQuery();
const replyForms = reactive<Record<number, string>>({});
const errorById = reactive<Record<number, string>>({});
const errorText = computed(() => (tasks.error.value instanceof Error ? tasks.error.value.message : String(tasks.error.value || "")));
const approvalCount = computed(() => (tasks.data.value?.pending || []).filter((task) => task.kind === "approval").length);

function formatTimeout(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs)) {
    return "-";
  }
  if (timeoutMs < 60_000) {
    return `${Math.round(timeoutMs / 1000)}s`;
  }
  return `${Math.round(timeoutMs / 60_000)}m`;
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["pending-tasks"] });
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function reply(id: number) {
  errorById[id] = "";
  const markdown = replyForms[id]?.trim();
  if (!markdown) {
    errorById[id] = "Reply markdown is required.";
    return;
  }
  try {
    await replyTask(id, markdown);
    replyForms[id] = "";
    await refresh();
  } catch (error) {
    errorById[id] = error instanceof Error ? error.message : String(error);
  }
}

async function drop(id: number) {
  errorById[id] = "";
  try {
    await dropTask(id);
    await refresh();
  } catch (error) {
    errorById[id] = error instanceof Error ? error.message : String(error);
  }
}

async function handleApproval(id: number, decision: "allow" | "deny" | "skip") {
  errorById[id] = "";
  try {
    if (decision === "allow") {
      await approveTask(id);
    } else if (decision === "deny") {
      await denyTask(id);
    } else {
      await skipTask(id);
    }
    await refresh();
  } catch (error) {
    errorById[id] = error instanceof Error ? error.message : String(error);
  }
}
</script>

<style src="../../styles/features/tasks.css"></style>
