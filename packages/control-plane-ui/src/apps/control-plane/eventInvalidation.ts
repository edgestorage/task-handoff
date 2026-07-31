import type { ControlPlaneQueryDomain } from "../../api/queryInvalidation.ts";

export type InvalidationEvent = {
  type?: string;
  topic?: string;
};

export function controlPlaneEventDomains(events: InvalidationEvent[]): ControlPlaneQueryDomain[] {
  const topics = new Set(events.map((event) => event.topic).filter(Boolean));
  const domains: ControlPlaneQueryDomain[] = [];
  if (topics.has("node.state")) domains.push("nodeState");
  if (topics.has("nodes")) domains.push("nodeTopology");
  if (topics.has("instances")) domains.push("instances");
  if (topics.has("projects")) domains.push("projects");
  if (topics.has("models")) domains.push("models");
  if (topics.has("images")) domains.push("images");
  if (topics.has("market")) domains.push("market");
  return domains;
}
