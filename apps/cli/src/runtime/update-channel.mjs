import semver from "semver";

export function updateChannelForVersion(version) {
  const prereleaseChannel = semver.prerelease(version)?.[0];
  return prereleaseChannel === "alpha" || prereleaseChannel === "beta" ? prereleaseChannel : "stable";
}

export function isExactSemanticVersion(version) {
  return version.trim() === version && !/^[v=]/.test(version) && semver.valid(version) !== null;
}
