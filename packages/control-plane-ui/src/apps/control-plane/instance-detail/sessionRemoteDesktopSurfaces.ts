import { computed, nextTick, shallowReactive, type InjectionKey } from "vue";
import type { SessionRemoteDesktopTarget } from "./sessionRemoteDesktopLinks.ts";

export type DesktopFrame = { source: HTMLVideoElement | HTMLCanvasElement; width: number; height: number };
export type DesktopSurface = {
  instanceId: string;
  sessionId: string;
  element: HTMLElement;
  active: boolean;
  preview: boolean;
  capabilities?: Record<string, unknown>;
  target?: SessionRemoteDesktopTarget;
  selectionChange?: (target: SessionRemoteDesktopTarget) => void;
  streamSize?: (size: { width: number; height: number }) => void;
  frame?: (frame: DesktopFrame) => void;
};
export const desktopSessionSurfaceKey = (instanceId: string, sessionId: string) => JSON.stringify([instanceId, sessionId]);

// One viewer owns the connection. Surfaces are consumers, never independent
// sessions. DOM handles and decoded frames stay inside this presentation boundary.
export function createSessionRemoteDesktopSurfaces() {
  const surfaces = shallowReactive(new Map<symbol, DesktopSurface>());
  const retained = shallowReactive(new Map<string, { instanceId: string; sessionId: string; capabilities?: Record<string, unknown>; target?: SessionRemoteDesktopTarget }>());
  const groups = computed(() => [...retained].map(([key, scope]) => {
    const consumers = [...surfaces.values()].filter(s => desktopSessionSurfaceKey(s.instanceId, s.sessionId) === key);
    const active = consumers.filter(s => s.active);
    const primary = active.find(s => !s.preview) ?? active[0];
    return { ...scope, key, consumers, primary, active: active.length > 0, preview: !active.some(s => !s.preview) };
  }));
  function update(id: symbol, surface: DesktopSurface) {
    const previousSurface = surfaces.get(id);
    if (previousSurface && desktopSessionSurfaceKey(previousSurface.instanceId, previousSurface.sessionId) !== desktopSessionSurfaceKey(surface.instanceId, surface.sessionId)) release(id);
    surfaces.set(id, surface);
    const key = desktopSessionSurfaceKey(surface.instanceId, surface.sessionId);
    const previous = retained.get(key);
    retained.set(key, { instanceId: surface.instanceId, sessionId: surface.sessionId, capabilities: surface.capabilities, target: previous?.target ?? surface.target });
  }
  function release(id: symbol) {
    surfaces.delete(id);
    // Allow a Teleport destination to change during the same render without
    // destroying its connection. Keep only scopes with a remaining consumer.
    void nextTick(() => {
      for (const key of retained.keys()) {
        if (![...surfaces.values()].some(s => desktopSessionSurfaceKey(s.instanceId, s.sessionId) === key)) {
          retained.delete(key);
        }
      }
    });
  }
  function selection(key: string, target: SessionRemoteDesktopTarget) {
    const scope = retained.get(key);
    if (scope) retained.set(key, { ...scope, target });
    for (const s of surfaces.values()) if (desktopSessionSurfaceKey(s.instanceId, s.sessionId) === key) s.selectionChange?.(target);
  }
  const frameSizes = new WeakMap<DesktopSurface, string>();
  function frame(key: string, value: DesktopFrame) {
    const group = groups.value.find(g => g.key === key);
    if (!group) return;
    const size = `${value.width}:${value.height}`;
    for (const s of group.consumers) {
      if (!s.active) continue;
      if (frameSizes.get(s) !== size) {
        frameSizes.set(s, size);
        s.streamSize?.({ width: value.width, height: value.height });
      }
      if (s !== group.primary) s.frame?.(value);
    }
  }
  function forget(instanceId: string, sessionId: string) {
    const key = desktopSessionSurfaceKey(instanceId, sessionId);
    retained.delete(key);
  }
  return { groups, update, release, selection, frame, forget };
}
export type SessionRemoteDesktopSurfaces = ReturnType<typeof createSessionRemoteDesktopSurfaces>;
export const sessionRemoteDesktopSurfacesKey: InjectionKey<SessionRemoteDesktopSurfaces> = Symbol("session-remote-desktop-surfaces");
