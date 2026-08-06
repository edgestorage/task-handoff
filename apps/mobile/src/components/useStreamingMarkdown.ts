import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_CHARS_PER_SECOND = 30;
const MAX_CHARS_PER_SECOND = 240;
const TARGET_LATENCY_MS = 240;
const CATCH_UP_LATENCY_MS = 160;
const CATCH_UP_THRESHOLD = 48;
const MAX_COMMIT_FPS = 30;
const MAX_CHARS_PER_COMMIT = 12;
const COMMIT_INTERVAL_MS = Math.ceil(1000 / MAX_COMMIT_FPS);

function graphemePrefix(value: string, count: number) {
  if (count <= 0 || !value) return '';
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;
  if (Segmenter) {
    const segments: string[] = [];
    for (const entry of new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
      segments.push(entry.segment);
      if (segments.length >= count) break;
    }
    return segments.join('');
  }
  return Array.from(value).slice(0, count).join('');
}

export function nextStreamingMarkdownCommit(visible: string, target: string) {
  if (!target.startsWith(visible)) return target;
  const remaining = target.slice(visible.length);
  if (!remaining) return visible;
  const backlog = Array.from(remaining).length;
  const targetBuffer = MIN_CHARS_PER_SECOND * (TARGET_LATENCY_MS / 1000);
  const catchUpBuffer = Math.max(CATCH_UP_THRESHOLD, MAX_CHARS_PER_SECOND * (CATCH_UP_LATENCY_MS / 1000));
  const pressure = Math.max(0, Math.min(1, (backlog - targetBuffer) / (catchUpBuffer - targetBuffer)));
  const charsPerSecond = MIN_CHARS_PER_SECOND + ((MAX_CHARS_PER_SECOND - MIN_CHARS_PER_SECOND) * pressure);
  const commitSize = Math.min(MAX_CHARS_PER_COMMIT, Math.max(1, Math.ceil(charsPerSecond / MAX_COMMIT_FPS)));
  return visible + graphemePrefix(remaining, commitSize);
}

export function useStreamingMarkdown(source: string, streaming: boolean, sourceKey?: string) {
  const [visible, setVisible] = useState(source);
  const [revealEnabled, setRevealEnabled] = useState(false);
  const visibleRef = useRef(source);
  const targetRef = useRef(source);
  const sourceRef = useRef(source);
  const sourceKeyRef = useRef<string | undefined>(undefined);
  const wasStreamingRef = useRef(streaming);
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

  const schedule = useCallback(() => {
    if (timerRef.current !== undefined || visibleRef.current === targetRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      const next = nextStreamingMarkdownCommit(visibleRef.current, targetRef.current);
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
      targetRef.current = source;
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
      targetRef.current = source;
      publish(source);
      return;
    }

    if (!source.startsWith(previousSource) || !source.startsWith(visibleRef.current)) {
      const generation = ++generationRef.current;
      stopTimer();
      targetRef.current = source;
      setRevealEnabled(false);
      publish(source);
      queueMicrotask(() => {
        if (generationRef.current === generation) setRevealEnabled(true);
      });
      return;
    }

    targetRef.current = source;
    schedule();
  }, [publish, schedule, source, sourceKey, stopTimer, streaming]);

  useEffect(() => () => {
    generationRef.current += 1;
    stopTimer();
  }, [stopTimer]);

  return { revealEnabled: Boolean(sourceKey) && revealEnabled, visible };
}
