import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { EmbeddedBrowserAccessRequestView } from "@task-handoff/protocol/embedded-browser-control";
import { controlledInstanceEmbeddedBrowserChannelCapabilities } from "@task-handoff/protocol/control-plane";
import {
  denyBrowserControlAccessRequest,
  getBrowserControlAccess,
  grantBrowserControlAccess,
} from "../../../api/browserControl";
import {
  BROWSER_ACCESS_REQUEST_CHANGED_EVENT,
  type BrowserCreationEventDetail,
} from "../instance-detail/browserCreationEvents";

export type BrowserAccessRequestInstance = {
  id: string;
  name: string;
  capabilities?: unknown;
};

export type BrowserAccessRequestItem = {
  type: "browser-access-request";
  key: string;
  instanceId: string;
  instanceName: string;
  request: EmbeddedBrowserAccessRequestView;
  sessionTitle?: string;
};

export function useBrowserAccessRequests(
  instances: () => readonly BrowserAccessRequestInstance[],
  enabled: () => boolean = () => true,
) {
  const items = ref<BrowserAccessRequestItem[]>([]);
  const requestEpochs = new Map<string, number>();
  let recoveryEpoch = 0;

  function eligible(instance: BrowserAccessRequestInstance) {
    const capabilities = controlledInstanceEmbeddedBrowserChannelCapabilities(instance.capabilities);
    return capabilities.supported && capabilities.targetCdp;
  }

  function itemFor(instance: BrowserAccessRequestInstance, request: EmbeddedBrowserAccessRequestView | undefined) {
    if (!request) return undefined;
    return {
      type: "browser-access-request" as const,
      key: `browser-access-request:${instance.id}:${request.requestRef}`,
      instanceId: instance.id,
      instanceName: instance.name,
      request,
    };
  }

  async function refreshInstance(instance: BrowserAccessRequestInstance) {
    if (!enabled() || !eligible(instance)) return;
    const epoch = (requestEpochs.get(instance.id) ?? 0) + 1;
    requestEpochs.set(instance.id, epoch);
    try {
      const access = await getBrowserControlAccess(instance.id);
      if (requestEpochs.get(instance.id) !== epoch) return;
      const item = itemFor(instance, access.pendingRequest);
      items.value = [
        ...items.value.filter((entry) => entry.instanceId !== instance.id),
        ...(item ? [item] : []),
      ];
    } catch {
      // A missing instance, revoked permission, or an older instance without
      // Target CDP simply contributes no approval item.
    }
  }

  async function recover() {
    if (!enabled()) {
      items.value = [];
      return;
    }
    const epoch = ++recoveryEpoch;
    const targets = instances().filter(eligible);
    await Promise.allSettled(targets.map((instance) => refreshInstance(instance)));
    if (epoch !== recoveryEpoch) return;
    const known = new Set(targets.map((instance) => instance.id));
    items.value = items.value.filter((item) => known.has(item.instanceId));
  }

  function handleEvent(event: Event) {
    const detail = (event as CustomEvent<BrowserCreationEventDetail>).detail;
    if (!detail?.instanceId) {
      void recover();
      return;
    }
    const instance = instances().find((entry) => entry.id === detail.instanceId);
    if (instance) void refreshInstance(instance);
  }

  async function approve(item: BrowserAccessRequestItem) {
    await grantBrowserControlAccess(item.instanceId, {
      requestRef: item.request.requestRef,
      expectedRevision: item.request.revision,
    });
    const instance = instances().find((entry) => entry.id === item.instanceId);
    if (instance) await refreshInstance(instance);
    else items.value = items.value.filter((entry) => entry.key !== item.key);
  }

  async function deny(item: BrowserAccessRequestItem) {
    await denyBrowserControlAccessRequest(item.instanceId, item.request.requestRef, item.request.revision);
    const instance = instances().find((entry) => entry.id === item.instanceId);
    if (instance) await refreshInstance(instance);
    else items.value = items.value.filter((entry) => entry.key !== item.key);
  }

  onMounted(() => {
    window.addEventListener(BROWSER_ACCESS_REQUEST_CHANGED_EVENT, handleEvent);
    void recover();
  });
  onBeforeUnmount(() => window.removeEventListener(BROWSER_ACCESS_REQUEST_CHANGED_EVENT, handleEvent));
  watch(
    () => [enabled(), instances().map((instance) => instance.id).sort().join("|")] as const,
    () => void recover(),
  );

  return { items, recover, approve, deny };
}
