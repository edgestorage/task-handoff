import type { FastifyContextConfig } from "fastify";

export type ControlPlaneAuthBoundary = "public" | "public-ui" | "proxy-binding" | "node-tunnel";

declare module "fastify" {
  interface FastifyContextConfig {
    controlPlaneAuthBoundary?: ControlPlaneAuthBoundary;
  }
}

export const PUBLIC_CONTROL_PLANE_ROUTE = {
  controlPlaneAuthBoundary: "public",
} as const satisfies FastifyContextConfig;

export const PUBLIC_CONTROL_PLANE_UI_ROUTE = {
  controlPlaneAuthBoundary: "public-ui",
} as const satisfies FastifyContextConfig;

export const PROXY_BINDING_ROUTE = {
  controlPlaneAuthBoundary: "proxy-binding",
} as const satisfies FastifyContextConfig;

export const NODE_TUNNEL_ROUTE = {
  controlPlaneAuthBoundary: "node-tunnel",
} as const satisfies FastifyContextConfig;
