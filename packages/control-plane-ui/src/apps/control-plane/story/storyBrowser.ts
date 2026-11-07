import type { InjectionKey } from "vue";

export type StoryBrowserRequest = (instanceId: string, url: string) => void;

export const storyBrowserRequestKey: InjectionKey<StoryBrowserRequest> = Symbol("story-browser-request");
