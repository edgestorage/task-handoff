export type WindowClaimResult = { action: "claimed" } | { action: "focused"; focused: boolean };

type WindowMessage = {
  type: "owner" | "claim" | "release" | "focus";
  instanceId: string;
  windowId: string;
};

export function createWebInstanceWindowCoordinator(options: {
  channel?: BroadcastChannel;
  focus?: () => void;
  locks?: Pick<LockManager, "request"> | null;
  windowId?: string;
  onOwnershipLost?: (instanceId: string) => void;
} = {}) {
  const channel = options.channel || new BroadcastChannel("task-handoff.instance-detail-windows");
  const windowId = options.windowId || crypto.randomUUID();
  const focus = options.focus || (() => window.focus());
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks || undefined;
  let currentInstanceId = "";
  let releaseCurrentLock: (() => Promise<void>) | undefined;
  const owners = new Map<string, { windowId: string; seenAt: number }>();
  const heartbeat = setInterval(() => {
    if (currentInstanceId) send({ type: "owner", instanceId: currentInstanceId, windowId });
  }, 1_000);

  function send(message: WindowMessage) {
    channel.postMessage(message);
  }

  function handleMessage(event: MessageEvent<WindowMessage>) {
    const message = event.data;
    if (!message?.instanceId || message.windowId === windowId) return;
    if (message.type === "release") {
      if (owners.get(message.instanceId)?.windowId === message.windowId) owners.delete(message.instanceId);
      return;
    }
    if (message.type === "owner") {
      if (currentInstanceId === message.instanceId && message.windowId < windowId && !locks) {
        const lostInstanceId = currentInstanceId;
        currentInstanceId = "";
        owners.set(message.instanceId, { windowId: message.windowId, seenAt: Date.now() });
        options.onOwnershipLost?.(lostInstanceId);
        return;
      }
      owners.set(message.instanceId, { windowId: message.windowId, seenAt: Date.now() });
      if (currentInstanceId === message.instanceId && message.windowId > windowId && !locks) {
        send({ type: "owner", instanceId: message.instanceId, windowId });
      }
      return;
    }
    if (message.type === "claim" && currentInstanceId === message.instanceId) {
      owners.set(message.instanceId, { windowId, seenAt: Date.now() });
      send({ type: "owner", instanceId: message.instanceId, windowId });
      return;
    }
    if (message.type === "focus" && currentInstanceId === message.instanceId) {
      focus();
      send({ type: "owner", instanceId: message.instanceId, windowId });
    }
  }

  channel.addEventListener("message", handleMessage as EventListener);

  async function discover(instanceId: string) {
    const known = owners.get(instanceId);
    if (known && Date.now() - known.seenAt > 3_000) owners.delete(instanceId);
    send({ type: "claim", instanceId, windowId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return owners.get(instanceId)?.windowId;
  }

  async function claim(instanceId: string): Promise<WindowClaimResult> {
    if (instanceId === currentInstanceId) return { action: "claimed" };
    let releaseTargetHold: (() => void) | undefined;
    let targetLockRequest: Promise<unknown> | undefined;
    let lockAcquired = false;
    if (locks) {
      let settleAcquired: (acquired: boolean) => void = () => undefined;
      const acquired = new Promise<boolean>((resolve) => { settleAcquired = resolve; });
      const held = new Promise<void>((resolve) => { releaseTargetHold = resolve; });
      targetLockRequest = locks.request(`task-handoff.instance-detail:${instanceId}`, { ifAvailable: true }, async (lock) => {
        lockAcquired = Boolean(lock);
        settleAcquired(lockAcquired);
        if (lock) await held;
      });
      await acquired;
    }
    const owner = lockAcquired ? undefined : await discover(instanceId);
    if ((!lockAcquired && locks) || (owner && owner !== windowId)) {
      send({ type: "focus", instanceId, windowId });
      return { action: "focused", focused: true };
    }
    if (releaseCurrentLock) await releaseCurrentLock();
    releaseCurrentLock = releaseTargetHold && targetLockRequest
      ? async () => {
          releaseTargetHold?.();
          await targetLockRequest;
        }
      : undefined;
    if (currentInstanceId) send({ type: "release", instanceId: currentInstanceId, windowId });
    currentInstanceId = instanceId;
    owners.set(instanceId, { windowId, seenAt: Date.now() });
    send({ type: "owner", instanceId, windowId });
    if (!locks) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (currentInstanceId !== instanceId) {
        send({ type: "focus", instanceId, windowId });
        return { action: "focused", focused: true };
      }
    }
    return { action: "claimed" };
  }

  function dispose() {
    clearInterval(heartbeat);
    void releaseCurrentLock?.();
    releaseCurrentLock = undefined;
    if (currentInstanceId) send({ type: "release", instanceId: currentInstanceId, windowId });
    channel.removeEventListener("message", handleMessage as EventListener);
    channel.close();
  }

  return { claim, dispose, currentInstanceId: () => currentInstanceId };
}
