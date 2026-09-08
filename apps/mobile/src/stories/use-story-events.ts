import { useEffect, useId, useRef } from 'react';
import {
  StoryAutomationChangedEventSchema,
  StoryAutomationChangedEventType,
  StoryChangedEventSchema,
  StoryChangedEventType,
} from '@task-handoff/protocol/stories';

import type { MobileControlPlaneEvent } from '../control-plane/transport';
import { useMobileControlPlaneRuntime } from '../control-plane/use-mobile-control-plane-runtime';

const STORY_REFRESH_DEBOUNCE_MS = 100;

export function useStoryEvents(refresh: (signal: AbortSignal) => Promise<unknown>, storyId?: string) {
  const runtime = useMobileControlPlaneRuntime();
  const domainId = useId();
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshInFlight: Promise<void> | undefined;
    let refreshAbortController: AbortController | undefined;
    let refreshQueued = false;

    const runRefresh = () => {
      if (refreshInFlight) {
        refreshQueued = true;
        return refreshInFlight;
      }
      const abortController = new AbortController();
      refreshAbortController = abortController;
      const request = Promise.resolve(refreshRef.current(abortController.signal)).then(() => undefined).finally(() => {
        if (refreshInFlight !== request) return;
        refreshInFlight = undefined;
        refreshAbortController = undefined;
        if (!refreshQueued || stopped) return;
        refreshQueued = false;
        scheduleRefresh();
      });
      refreshInFlight = request;
      return request;
    };
    const scheduleRefresh = () => {
      if (refreshTimer || stopped) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void runRefresh().catch(() => undefined);
      }, STORY_REFRESH_DEBOUNCE_MS);
    };
    const stop = () => {
      stopped = true;
      refreshAbortController?.abort();
      refreshAbortController = undefined;
      refreshInFlight = undefined;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      refreshQueued = false;
    };
    const accepts = (event: MobileControlPlaneEvent) => {
      if (event.topic !== 'stories') return false;
      const eventStoryId = storyEventStoryId(event);
      return !storyId || !eventStoryId || eventStoryId === storyId;
    };

    if (!runtime.coordinator) {
      void runRefresh().catch(() => undefined);
      return stop;
    }
    return runtime.coordinator.register({
      key: `stories:${domainId}`,
      topics: ['stories'],
      start: () => {
        stopped = false;
        return runRefresh();
      },
      stop,
      offline: stop,
      onEvent: (event) => {
        if (accepts(event)) scheduleRefresh();
      },
      onConnectionError: () => undefined,
    });
  }, [domainId, runtime.coordinator, storyId]);
}

function storyEventStoryId(event: MobileControlPlaneEvent) {
  if (event.type === StoryChangedEventType) {
    const parsed = StoryChangedEventSchema.safeParse(event.payload);
    return parsed.success ? parsed.data.storyId : undefined;
  }
  if (event.type === StoryAutomationChangedEventType) {
    const parsed = StoryAutomationChangedEventSchema.safeParse(event.payload);
    return parsed.success ? parsed.data.storyId : undefined;
  }
  return undefined;
}
