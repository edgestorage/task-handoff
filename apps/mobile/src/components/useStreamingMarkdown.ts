import { useCallback, useEffect, useRef, useState } from 'react';

import { splitGraphemes } from './graphemes';

const MIN_CHARS_PER_SECOND = 30;
const MAX_CHARS_PER_SECOND = 240;
const TARGET_LATENCY_MS = 240;
const CATCH_UP_LATENCY_MS = 160;
const CATCH_UP_THRESHOLD = 48;
const MAX_COMMIT_FPS = 30;
const MAX_CHARS_PER_COMMIT = 12;
const COMMIT_INTERVAL_MS = Math.ceil(1000 / MAX_COMMIT_FPS);
function streamingCommitSize(backlog: number) {
  if (backlog <= 0) return 0;
  const targetBuffer = MIN_CHARS_PER_SECOND * (TARGET_LATENCY_MS / 1000);
  const catchUpBuffer = Math.max(CATCH_UP_THRESHOLD, MAX_CHARS_PER_SECOND * (CATCH_UP_LATENCY_MS / 1000));
  const pressure = Math.max(0, Math.min(1, (backlog - targetBuffer) / (catchUpBuffer - targetBuffer)));
  const charsPerSecond = MIN_CHARS_PER_SECOND + ((MAX_CHARS_PER_SECOND - MIN_CHARS_PER_SECOND) * pressure);
  return Math.min(MAX_CHARS_PER_COMMIT, Math.max(1, Math.ceil(charsPerSecond / MAX_COMMIT_FPS)));
}

export function nextStreamingMarkdownCommit(visible: string, target: string) {
  if (!target.startsWith(visible)) return target;
  const remaining = target.slice(visible.length);
  if (!remaining) return visible;
  const graphemes = splitGraphemes(remaining);
  return visible + graphemes.slice(0, streamingCommitSize(graphemes.length)).join('');
}

export function useStreamingMarkdown(source: string, streaming: boolean, sourceKey?: string) {
  const [visible, setVisible] = useState(source);
  const [revealEnabled, setRevealEnabled] = useState(false);
  const visibleRef = useRef(source);
  const sourceRef = useRef(source);
  const sourceKeyRef = useRef<string | undefined>(undefined);
  const wasStreamingRef = useRef(streaming);
  const graphemeQueueRef = useRef<string[]>([]);
  const graphemeCursorRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generationRef = useRef(0);
  const scheduleRef = useRef<() => void>(() => undefined);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const publish = useCallback((next: string) => {
    visibleRef.current = next;
    setVisible(next);
  }, []);

  const rebuildQueue = useCallback((target: string) => {
    const remaining = target.startsWith(visibleRef.current)
      ? target.slice(visibleRef.current.length)
      : '';
    graphemeQueueRef.current = splitGraphemes(remaining);
    graphemeCursorRef.current = 0;
  }, []);

  const schedule = useCallback(() => {
    if (
      timerRef.current !== undefined
      || graphemeCursorRef.current >= graphemeQueueRef.current.length
    ) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      const backlog = graphemeQueueRef.current.length - graphemeCursorRef.current;
      const nextCursor = graphemeCursorRef.current + streamingCommitSize(backlog);
      const addition = graphemeQueueRef.current
        .slice(graphemeCursorRef.current, nextCursor)
        .join('');
      graphemeCursorRef.current = nextCursor;
      const next = visibleRef.current + addition;
      publish(next);
      scheduleRef.current();
    }, COMMIT_INTERVAL_MS);
  }, [publish]);

  useEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

  useEffect(() => {
    const keyChanged = sourceKeyRef.current !== sourceKey;
    if (keyChanged) {
      const generation = ++generationRef.current;
      stopTimer();
      sourceKeyRef.current = sourceKey;
      sourceRef.current = source;
      graphemeQueueRef.current = [];
      graphemeCursorRef.current = 0;
      wasStreamingRef.current = streaming;
      setRevealEnabled(false);
      publish(source);
      queueMicrotask(() => {
        if (generationRef.current === generation) setRevealEnabled(true);
      });
      return;
    }

    const previousSource = sourceRef.current;
    const wasStreaming = wasStreamingRef.current;
    sourceRef.current = source;
    wasStreamingRef.current = streaming;

    if (!streaming && !wasStreaming) {
      stopTimer();
      graphemeQueueRef.current = [];
      graphemeCursorRef.current = 0;
      publish(source);
      return;
    }

    if (!source.startsWith(previousSource) || !source.startsWith(visibleRef.current)) {
      const generation = ++generationRef.current;
      stopTimer();
      graphemeQueueRef.current = [];
      graphemeCursorRef.current = 0;
      setRevealEnabled(false);
      publish(source);
      queueMicrotask(() => {
        if (generationRef.current === generation) setRevealEnabled(true);
      });
      return;
    }

    rebuildQueue(source);
    schedule();
  }, [publish, rebuildQueue, schedule, source, sourceKey, stopTimer, streaming]);

  useEffect(() => () => {
    generationRef.current += 1;
    stopTimer();
  }, [stopTimer]);

  return { revealEnabled: Boolean(sourceKey) && revealEnabled, visible };
}
