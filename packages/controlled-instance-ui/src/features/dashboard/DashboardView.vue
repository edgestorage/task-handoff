<template>
  <section class="panel">
    <h1>Dashboard</h1>
    <dl v-if="status.data.value" class="stats">
      <div>
        <dt>Running apps</dt>
        <dd>{{ status.data.value.runningAppCount }}</dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd>{{ status.data.value.version }}</dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>{{ formatDate(status.data.value.startedAt) }}</dd>
      </div>
    </dl>

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
import { useDiagnosticsQuery, useStatusQuery } from "../../api/queries";

const status = useStatusQuery();
const diagnostics = useDiagnosticsQuery();

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<style src="../../styles/features/dashboard.css"></style>
