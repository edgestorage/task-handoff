export const BROWSER_ACCESS_CHANGED_EVENT = "task-handoff:browser-access-changed";
export const BROWSER_ACCESS_REQUEST_CHANGED_EVENT = "task-handoff:browser-access-request-changed";
export const BROWSER_CREATION_CONTEXT_CHANGED_EVENT = "task-handoff:browser-creation-context-changed";

export type BrowserCreationEventDetail = {
  instanceId?: string;
  payload?: unknown;
};

export function dispatchBrowserCreationEvent(type: string, detail: BrowserCreationEventDetail) {
  window.dispatchEvent(new CustomEvent<BrowserCreationEventDetail>(type, { detail }));
}
