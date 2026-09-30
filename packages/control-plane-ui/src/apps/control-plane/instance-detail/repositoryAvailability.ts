import type { RepositoryContext } from "@task-handoff/protocol/repository";
import type { Translate } from "../../../i18n/status";

// Availability copy is defined once so every repository surface describes the
// same authoritative instance state with the same words.
const availabilityMessageKeys: Record<RepositoryContext["availability"], string> = {
  available: "repository.environmentExtra.availability.available",
  "session-not-found": "repository.environment.unavailable.sessionNotFound",
  "session-inactive": "repository.environment.unavailable.sessionInactive",
  "cwd-missing": "repository.environmentExtra.availability.cwdMissing",
  "cwd-inaccessible": "repository.environmentExtra.availability.cwdInaccessible",
  "git-unavailable": "repository.environmentExtra.availability.gitUnavailable",
  "not-worktree": "repository.environmentExtra.availability.notWorktree",
};

export function repositoryAvailabilityMessage(availability: RepositoryContext["availability"] | undefined, t: Translate) {
  return t(availabilityMessageKeys[availability || "cwd-missing"]);
}
