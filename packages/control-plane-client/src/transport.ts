import type { z } from "zod";

export interface ControlPlaneClientTransport {
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, onUploadProgress?: (progress: number) => void): Promise<T>;
}
