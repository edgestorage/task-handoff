import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ManagedAppRecipeLibc, ManagedAppRecipeTarget } from "./types";

const NATIVE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/i;
const NATIVE_PACKAGE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,120}$/;
const NPM_INTEGRITY = /^sha(256|512)-([A-Za-z0-9+/]+={0,2})$/;
const MAX_NATIVE_MANIFEST_FILES = 100_000;

export type NativeAppManifest = {
  schemaVersion: 1;
  appId: string;
  version: string;
  package: string;
  packageVersion: string;
  integrity: string;
  installRoot: string;
  launchPath: string;
  files: string[];
};

export function managedNativeAppRoot(root: string, appId: string) {
  return path.join(root, "native", appId);
}

export function managedNativeAppLauncher(root: string, appId: string, launchPath: string) {
  return path.join(managedNativeAppRoot(root, appId), launchPath);
}

export function managedNativeAppManifestPath(root: string, appId: string) {
  return path.join(managedNativeAppRoot(root, appId), "managed-app.json");
}

export function validNativeAppLaunchPath(value: string) {
  if (!value || value.length > 1_024 || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  if (path.posix.normalize(value) !== value) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.length <= 100 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function validNativePackageIntegrity(value: string) {
  const match = NPM_INTEGRITY.exec(value);
  if (!match) return false;
  const digest = Buffer.from(match[2], "base64");
  return digest.length === (match[1] === "256" ? 32 : 64) && digest.toString("base64") === match[2];
}

export function readNativeAppManifest(root: string, appId: string): NativeAppManifest | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(managedNativeAppManifestPath(root, appId), "utf8")) as Partial<NativeAppManifest>;
    if (value.schemaVersion !== 1 || value.appId !== appId || typeof value.version !== "string") return undefined;
    if (typeof value.package !== "string" || typeof value.packageVersion !== "string" || typeof value.integrity !== "string") return undefined;
    if (typeof value.installRoot !== "string" || typeof value.launchPath !== "string" || !Array.isArray(value.files)) return undefined;
    if (!value.version.trim() || !NATIVE_PACKAGE_NAME.test(value.package) || !NATIVE_PACKAGE_VERSION.test(value.packageVersion)) return undefined;
    if (!validNativePackageIntegrity(value.integrity) || !validNativeAppLaunchPath(value.launchPath)) return undefined;
    const expectedInstallRoot = path.resolve(managedNativeAppRoot(root, appId));
    if (!path.isAbsolute(value.installRoot) || path.resolve(value.installRoot) !== expectedInstallRoot) return undefined;
    if (value.files.length > MAX_NATIVE_MANIFEST_FILES || !value.files.every((file) => typeof file === "string" && validNativeAppLaunchPath(file))) return undefined;
    return value as NativeAppManifest;
  } catch {
    return undefined;
  }
}

function detectsMusl() {
  if (fs.existsSync("/etc/alpine-release")) return true;
  try {
    const result = spawnSync("ldd", ["--version"], { encoding: "utf8", timeout: 1_500 });
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl");
  } catch {
    return false;
  }
}

export function detectManagedAppRecipeTarget(options: { platform?: NodeJS.Platform } = {}): ManagedAppRecipeTarget {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return {};
  const libc: ManagedAppRecipeLibc = detectsMusl() ? "musl" : "gnu";
  return { libc };
}
