export const BROWSER_CREATION_CHANGED_EVENT = "task-handoff:browser-creation-changed";
export const BROWSER_CREATION_REFRESH_EVENT = "task-handoff:browser-creation-refresh";
export const BROWSER_ACCESS_CHANGED_EVENT = "task-handoff:browser-access-changed";

export type BrowserCreationEventDetail = {
  instanceId?: string;
  payload?: unknown;
};

export function dispatchBrowserCreationEvent(type: string, detail: BrowserCreationEventDetail) {
  window.dispatchEvent(new CustomEvent<BrowserCreationEventDetail>(type, { detail }));
}
