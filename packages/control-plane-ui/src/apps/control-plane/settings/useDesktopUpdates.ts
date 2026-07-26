import { onBeforeUnmount, onMounted, ref } from "vue";

export type DesktopUpdateChannel = "stable" | "beta" | "alpha";
export type DesktopUpdatePhase = "unsupported" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "up-to-date" | "error";

export type DesktopUpdateState = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  channel: DesktopUpdateChannel;
  capabilities: {
    check: boolean;
    download: boolean;
    install: boolean;
    reason?: string;
  };
  progress?: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  };
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl: string;
  error?: {
    code: string;
    message: string;
  };
};

export type DesktopUpdateBridge = {
  getState: () => Promise<DesktopUpdateState | undefined>;
  check: () => Promise<DesktopUpdateState | undefined>;
  download: () => Promise<DesktopUpdateState | undefined>;
  install: () => Promise<DesktopUpdateState | undefined>;
  setChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState | undefined>;
  openReleasePage: () => Promise<void>;
  onStateChanged: (listener: (state: DesktopUpdateState) => void) => () => void;
};

type DesktopWindow = Window & {
  taskHandoffDesktop?: {
    desktopUpdates?: DesktopUpdateBridge;
  };
};

export function useDesktopUpdates() {
  const bridge = (window as DesktopWindow).taskHandoffDesktop?.desktopUpdates;
  const state = ref<DesktopUpdateState>();
  let unsubscribe: (() => void) | undefined;

  async function run(action: () => Promise<DesktopUpdateState | undefined>) {
    const result = await action();
    if (result) state.value = result;
  }

  onMounted(async () => {
    if (!bridge) return;
    unsubscribe = bridge.onStateChanged((next) => {
      state.value = next;
    });
    await run(() => bridge.getState());
  });

  onBeforeUnmount(() => unsubscribe?.());

  return {
    available: Boolean(bridge),
    state,
    check: () => bridge ? run(() => bridge.check()) : Promise.resolve(),
    download: () => bridge ? run(() => bridge.download()) : Promise.resolve(),
    install: () => bridge ? run(() => bridge.install()) : Promise.resolve(),
    setChannel: (channel: DesktopUpdateChannel) => bridge ? run(() => bridge.setChannel(channel)) : Promise.resolve(),
    openReleasePage: () => bridge?.openReleasePage() || Promise.resolve(),
  };
}
