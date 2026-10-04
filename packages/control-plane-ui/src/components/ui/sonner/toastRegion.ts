import { shallowRef } from "vue";

export type VisibleToastBounds = { top: number; bottom: number; left: number; right: number; height: number };

export const visibleToastBounds = shallowRef<VisibleToastBounds[]>([]);
