import { reactive } from "vue";
import type { AppManagementEvent, AppManagementJob, AppManagementSnapshot } from "../../../api/types";

type InstanceAppManagementState = {
  snapshot?: AppManagementSnapshot;
  loading: boolean;
  error: string;
  recovery: number;
  buffered: AppManagementEvent[];
  retiredStreams: Set<string>;
};

export function useInstanceAppManagement(options: {
  load: (instanceId: string) => Promise<AppManagementSnapshot>;
  errorText: (error: unknown) => string;
}) {
  const states = reactive<Record<string, InstanceAppManagementState>>({});

  function state(instanceId: string) {
    return states[instanceId] || (states[instanceId] = { loading: false, error: "", recovery: 0, buffered: [], retiredStreams: new Set() });
  }

  async function recover(instanceId: string) {
    if (!instanceId) return;
    const current = state(instanceId);
    const recovery = ++current.recovery;
    current.loading = true;
    current.error = "";
    try {
      const snapshot = await options.load(instanceId);
      if (current.recovery !== recovery) return;
      if (current.snapshot?.streamId !== snapshot.streamId) retireStream(current, current.snapshot?.streamId);
      current.snapshot = snapshot;
      const buffered = current.buffered.splice(0).sort((a, b) => a.sequence - b.sequence);
      for (const event of buffered) {
        if (!current.retiredStreams.has(event.streamId) && (event.streamId !== snapshot.streamId || event.sequence > snapshot.sequence)) applyAuthoritativeEvent(current, event);
      }
    } catch (error) {
      if (current.recovery === recovery) {
        current.snapshot = undefined;
        current.error = options.errorText(error);
      }
    } finally {
      if (current.recovery === recovery) current.loading = false;
    }
  }

  function applyEvent(instanceId: string, event: AppManagementEvent) {
    if (!instanceId) return false;
    const current = state(instanceId);
    if (current.retiredStreams.has(event.streamId)) return true;
    if (current.loading || !current.snapshot) {
      current.buffered.push(event);
      if (current.buffered.length > 256) current.buffered.splice(0, current.buffered.length - 256);
      if (!current.loading) void recover(instanceId);
      return true;
    }
    if (event.streamId !== current.snapshot.streamId && !event.snapshot) {
      current.buffered.push(event);
      void recover(instanceId);
      return true;
    }
    applyAuthoritativeEvent(current, event);
    return true;
  }

  function applyJob(instanceId: string, job: AppManagementJob) {
    const current = state(instanceId);
    if (!current.snapshot) return;
    current.snapshot = snapshotWithJob(current.snapshot, job);
  }

  function clear(instanceId: string) {
    delete states[instanceId];
  }

  return { applyEvent, applyJob, clear, recover, state };
}

function applyAuthoritativeEvent(state: InstanceAppManagementState, event: AppManagementEvent) {
  if (state.snapshot && event.streamId !== state.snapshot.streamId) {
    if (event.snapshot) {
      retireStream(state, state.snapshot.streamId);
      state.snapshot = event.snapshot;
    }
  } else if (state.snapshot && event.sequence <= state.snapshot.sequence) return;
  if (event.snapshot) state.snapshot = event.snapshot;
  else if (event.job && state.snapshot) state.snapshot = snapshotWithJob(state.snapshot, event.job, event.sequence, event.observedAt);
  state.error = "";
}

function retireStream(state: InstanceAppManagementState, streamId?: string) {
  if (!streamId) return;
  state.retiredStreams.add(streamId);
  while (state.retiredStreams.size > 32) {
    const oldest = state.retiredStreams.values().next().value;
    if (oldest) state.retiredStreams.delete(oldest);
    else break;
  }
}

function snapshotWithJob(snapshot: AppManagementSnapshot, job: AppManagementJob, sequence = snapshot.sequence, observedAt = snapshot.observedAt): AppManagementSnapshot {
  const active = job.state === "queued" || job.state === "running";
  const activeJobs = snapshot.activeJobs.filter((item) => item.id !== job.id && item.appId !== job.appId);
  const recentJobs = snapshot.recentJobs.filter((item) => item.id !== job.id);
  if (active) activeJobs.push(job);
  else recentJobs.unshift(job);
  return {
    ...snapshot,
    sequence,
    activeJobs,
    recentJobs: recentJobs.slice(0, 50),
    apps: snapshot.apps.map((app) => app.id === job.appId
      ? { ...app, ...(active ? { activeJobId: job.id, canInstall: false, canUninstall: false } : { activeJobId: undefined }) }
      : app),
    observedAt,
  };
}
