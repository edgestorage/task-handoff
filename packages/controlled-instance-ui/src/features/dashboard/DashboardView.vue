<template>
  <section class="panel">
    <h1>Dashboard</h1>
    <dl v-if="status.data.value" class="stats">
      <div>
        <dt>Receiver</dt>
        <dd>{{ status.data.value.receiver.running ? `running pid ${status.data.value.receiver.pid}` : "stopped" }}</dd>
      </div>
      <div>
        <dt>Socket</dt>
        <dd>{{ status.data.value.socketPath }}</dd>
      </div>
      <div>
        <dt>Default conversation</dt>
        <dd>{{ status.data.value.defaultConversationId }}</dd>
      </div>
      <div>
        <dt>Pending tasks</dt>
        <dd>{{ status.data.value.pendingTaskCount }}</dd>
      </div>
      <div>
        <dt>Running apps</dt>
        <dd>{{ status.data.value.runningAppCount }}</dd>
      </div>
    </dl>
    <div class="actions">
      <Button size="sm" @click="start">Start receiver</Button>
      <Button variant="outline" size="sm" @click="stop">Stop receiver</Button>
    </div>
    <p v-if="receiverActionError" class="form-error">{{ receiverActionError }}</p>

    <section class="receiver-logs">
      <div class="section-head">
        <h2>Receiver Logs</h2>
        <span>{{ receiverLogs.data.value?.logPath || "receiver.log" }}</span>
      </div>
      <ScrollArea v-if="receiverLogs.data.value?.content" class="receiver-logs-scroll">
        <pre>{{ receiverLogs.data.value.content }}</pre>
      </ScrollArea>
      <p v-else class="logs-empty">No receiver logs yet.</p>
    </section>

    <section v-if="diagnostics.data.value" class="diagnostics-grid">
      <div class="diagnostics-card">
        <h2>Runtime</h2>
        <dl>
          <div>
            <dt>Platform</dt>
            <dd>{{ diagnostics.data.value.runtime.platform }} / {{ diagnostics.data.value.runtime.arch }}</dd>
          </div>
          <div>
            <dt>Linux runtime</dt>
            <dd>{{ diagnostics.data.value.runtime.linuxRuntime ? "ready" : "unsupported" }}</dd>
          </div>
          <div>
            <dt>Node</dt>
            <dd>{{ diagnostics.data.value.runtime.node }}</dd>
          </div>
          <div>
            <dt>noVNC</dt>
            <dd>{{ diagnostics.data.value.noVnc.available ? diagnostics.data.value.noVnc.root : "missing" }}</dd>
          </div>
        </dl>
      </div>

      <div class="diagnostics-card">
        <h2>Commands</h2>
        <ul class="diagnostics-list">
          <li v-for="command in diagnostics.data.value.commands" :key="command.name">
            <span :class="command.available ? 'dot-ok' : 'dot-bad'" />
            <div>
              <strong>{{ command.name }}</strong>
              <small>{{ command.available ? command.path : command.requiredFor.join(", ") }}</small>
            </div>
          </li>
        </ul>
      </div>

      <div class="diagnostics-card diagnostics-wide">
        <h2>Storage</h2>
        <ul class="diagnostics-list storage-list">
          <li v-for="entry in diagnostics.data.value.storage" :key="entry.key">
            <span :class="entry.writable ? 'dot-ok' : 'dot-bad'" />
            <div>
              <strong>{{ entry.key }}</strong>
              <small>{{ entry.writable ? "writable" : "not writable" }} · {{ entry.path }}</small>
            </div>
          </li>
        </ul>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { ref } from "vue";
import { startReceiver, stopReceiver, useDiagnosticsQuery, useReceiverLogsQuery, useStatusQuery } from "../../api/queries";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";

const status = useStatusQuery();
const diagnostics = useDiagnosticsQuery();
const receiverLogs = useReceiverLogsQuery();
const queryClient = useQueryClient();
const receiverActionError = ref("");

async function start() {
  receiverActionError.value = "";
  try {
    await startReceiver();
    await queryClient.invalidateQueries({ queryKey: ["status"] });
    await queryClient.invalidateQueries({ queryKey: ["receiver-logs"] });
  } catch (error) {
    receiverActionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function stop() {
  receiverActionError.value = "";
  try {
    await stopReceiver();
    await queryClient.invalidateQueries({ queryKey: ["status"] });
    await queryClient.invalidateQueries({ queryKey: ["receiver-logs"] });
  } catch (error) {
    receiverActionError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>

<style src="../../styles/features/dashboard.css"></style>
