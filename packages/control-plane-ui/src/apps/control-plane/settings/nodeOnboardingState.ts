export type ReachabilityStatus = "checking" | "reachable" | "unreachable" | "inconclusive";
export type ReachabilityValue = "publicly-reachable" | "not-publicly-reachable";

export type ReachabilityProbe = {
  status: ReachabilityStatus;
  checkedOrigin?: string;
  checkedAt?: string;
  reason?: "invalid-origin" | "private-host" | "insecure-http" | "request-failed";
};

export type ReachabilitySelection = {
  value: ReachabilityValue;
  source: "probe" | "user";
};

export type ReachabilityDecision = {
  probe: ReachabilityProbe;
  selection: ReachabilitySelection;
};

export function initialReachabilityDecision(): ReachabilityDecision {
  return {
    probe: { status: "checking" },
    selection: { value: "not-publicly-reachable", source: "probe" },
  };
}

export function applyReachabilityProbe(
  decision: ReachabilityDecision,
  probe: ReachabilityProbe,
): ReachabilityDecision {
  return {
    probe,
    selection: decision.selection.source === "user"
      ? decision.selection
      : {
          value: probe.status === "reachable" ? "publicly-reachable" : "not-publicly-reachable",
          source: "probe",
        },
  };
}

export function selectReachability(
  decision: ReachabilityDecision,
  value: ReachabilityValue,
): ReachabilityDecision {
  return { ...decision, selection: { value, source: "user" } };
}

export function reachabilityConflict(decision: ReachabilityDecision) {
  if (decision.selection.source !== "user") return false;
  if (decision.probe.status === "reachable") return decision.selection.value !== "publicly-reachable";
  if (decision.probe.status === "unreachable") return decision.selection.value !== "not-publicly-reachable";
  return false;
}

export async function probeControlPlaneOrigin(
  value: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number } = {},
): Promise<ReachabilityProbe> {
  const checkedAt = (options.now || (() => new Date()))().toISOString();
  let origin: URL;
  try {
    origin = new URL(value.trim());
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || !origin.hostname) throw new Error("invalid");
  } catch {
    return { status: "inconclusive", checkedOrigin: value.trim(), checkedAt, reason: "invalid-origin" };
  }

  const checkedOrigin = origin.origin;
  if (isPrivateHostname(origin.hostname)) {
    return { status: "unreachable", checkedOrigin, checkedAt, reason: "private-host" };
  }
  if (origin.protocol !== "https:") {
    return { status: "inconclusive", checkedOrigin, checkedAt, reason: "insecure-http" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    await (options.fetchImpl || fetch)(new URL("/api/health", origin), {
      cache: "no-store",
      mode: "no-cors",
      signal: controller.signal,
    });
    return { status: "reachable", checkedOrigin, checkedAt };
  } catch {
    return { status: "unreachable", checkedOrigin, checkedAt, reason: "request-failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function directEndpointIssue(value: string) {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
    if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || !endpoint.hostname) return "invalid" as const;
  } catch {
    return "invalid" as const;
  }
  if (endpoint.protocol === "http:" && !isPrivateHostname(endpoint.hostname)) return "public-http" as const;
  return undefined;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized === "::1") return true;
  const isIpv6Literal = normalized.includes(":");
  if (isIpv6Literal && (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:"))) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}
