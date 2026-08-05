import type { z } from "zod";

export interface ControlPlaneClientTransport {
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>;
}
