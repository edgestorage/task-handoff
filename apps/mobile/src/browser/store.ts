export type MobileBrowserTab = {
  id: string;
  controlPlaneId: string;
  instanceId: string;
  title: string;
  currentUrl: string;
  createdAt: string;
};

type Listener = () => void;

export class MobileBrowserTabStore {
  private tabs: MobileBrowserTab[] = [];
  private activeTabId?: string;
  private snapshotValue: { tabs: MobileBrowserTab[]; activeTabId?: string } = { tabs: [] };
  private readonly listeners = new Set<Listener>();

  constructor(private readonly createId = defaultId, private readonly now = () => new Date().toISOString()) {}

  snapshot = () => this.snapshotValue;
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  create(controlPlaneId: string, instanceId: string, initialUrl = 'about:blank') {
    const tab: MobileBrowserTab = {
      id: this.createId(), controlPlaneId, instanceId, title: '', currentUrl: initialUrl, createdAt: this.now(),
    };
    this.tabs = [...this.tabs, tab];
    this.activeTabId = tab.id;
    this.emit();
    return tab;
  }

  update(controlPlaneId: string, instanceId: string, tabId: string, patch: Partial<Pick<MobileBrowserTab, 'title' | 'currentUrl'>>) {
    let changed = false;
    this.tabs = this.tabs.map((tab) => {
      if (tab.controlPlaneId !== controlPlaneId || tab.instanceId !== instanceId || tab.id !== tabId) return tab;
      changed = true
      return { ...tab, ...patch };
    });
    if (changed) this.emit();
    return changed;
  }

  activate(controlPlaneId: string, instanceId: string, tabId: string) {
    if (!this.tabs.some((tab) => tab.controlPlaneId === controlPlaneId && tab.instanceId === instanceId && tab.id === tabId)) return false;
    this.activeTabId = tabId;
    this.emit();
    return true;
  }

  close(controlPlaneId: string, instanceId: string, tabId: string) {
    const index = this.tabs.findIndex((tab) => tab.controlPlaneId === controlPlaneId && tab.instanceId === instanceId && tab.id === tabId);
    if (index < 0) return false;
    this.tabs = this.tabs.filter((_, candidate) => candidate !== index);
    if (this.activeTabId === tabId) {
      const sameContext = this.tabs.filter((tab) => tab.controlPlaneId === controlPlaneId && tab.instanceId === instanceId);
      this.activeTabId = sameContext[Math.min(index, sameContext.length - 1)]?.id ?? this.tabs.at(-1)?.id;
    }
    this.emit();
    return true;
  }

  clearProfile(controlPlaneId: string) {
    const removed = this.tabs.filter((tab) => tab.controlPlaneId === controlPlaneId);
    if (!removed.length) return [];
    this.tabs = this.tabs.filter((tab) => tab.controlPlaneId !== controlPlaneId);
    if (removed.some((tab) => tab.id === this.activeTabId)) this.activeTabId = this.tabs.at(-1)?.id;
    this.emit();
    return [...new Set(removed.map((tab) => tab.instanceId))];
  }

  tabsFor(controlPlaneId: string, instanceId?: string) {
    return this.tabs.filter((tab) => tab.controlPlaneId === controlPlaneId && (!instanceId || tab.instanceId === instanceId));
  }

  private emit() {
    this.snapshotValue = { tabs: this.tabs, activeTabId: this.activeTabId };
    for (const listener of this.listeners) listener();
  }
}

let idCounter = 0;
function defaultId() { idCounter += 1; return `browser_${Date.now().toString(36)}_${idCounter.toString(36)}`; }

export const mobileBrowserTabStore = new MobileBrowserTabStore();
