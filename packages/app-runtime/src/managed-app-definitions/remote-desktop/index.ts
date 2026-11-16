import fs from "node:fs";
import { z } from "zod";
import path from "node:path";
import {
  managedNativeAppManifestPath,
  managedNativeAppRoot,
  readNativeAppManifest,
  validNativePackageIntegrity,
} from "../../native-package";
import type { ManagedAppProvider } from "../types";

export const DESKTOP_COMPONENT_APP_ID = "remote-desktop";
const DESKTOP_COMPONENT_UNIX_EXECUTABLE = "bin/task-handoff-desktop-streaming";
const DESKTOP_COMPONENT_WINDOWS_EXECUTABLE = `${DESKTOP_COMPONENT_UNIX_EXECUTABLE}.exe`;
export const DESKTOP_COMPONENT_EXECUTABLE = process.platform === "win32"
  ? DESKTOP_COMPONENT_WINDOWS_EXECUTABLE
  : DESKTOP_COMPONENT_UNIX_EXECUTABLE;
export const DESKTOP_COMPONENT_PACKAGE_PREFIX = "@task-handoff/remote-desktop";

/** The component release train is independent from the controlled-instance version. */
export function desktopProvider(): ManagedAppProvider {
  return {
    id: DESKTOP_COMPONENT_APP_ID,
    definition: () => ({
      launcher: {
        id: DESKTOP_COMPONENT_APP_ID,
        name: "Remote Desktop",
        kind: "tty",
        command: DESKTOP_COMPONENT_EXECUTABLE,
        description: "Optional instance desktop streaming component.",
      },
      launchable: false,
      detection: [{ type: "launcher-executable", versionArgs: ["--version"] }],
      distribution: {
        recipes: [
          {
            type: "registry-native-package" as const,
            platforms: ["linux" as const],
            arches: ["x64" as const, "arm64" as const],
            libc: "gnu" as const,
            privilege: "user" as const,
            packagePrefix: DESKTOP_COMPONENT_PACKAGE_PREFIX,
            launchPath: DESKTOP_COMPONENT_UNIX_EXECUTABLE,
          },
          {
            type: "registry-native-package" as const,
            platforms: ["darwin" as const],
            arches: ["x64" as const, "arm64" as const],
            privilege: "user" as const,
            packagePrefix: DESKTOP_COMPONENT_PACKAGE_PREFIX,
            launchPath: DESKTOP_COMPONENT_UNIX_EXECUTABLE,
          },
          {
            type: "registry-native-package" as const,
            platforms: ["win32" as const],
            arches: ["x64" as const],
            privilege: "user" as const,
            packagePrefix: DESKTOP_COMPONENT_PACKAGE_PREFIX,
            launchPath: DESKTOP_COMPONENT_WINDOWS_EXECUTABLE,
          },
          {
            type: "archive-ownership" as const,
            platforms: ["linux" as const, "darwin" as const, "win32" as const],
            arches: ["x64" as const, "arm64" as const],
            privilege: "user" as const,
            installRoot: DESKTOP_COMPONENT_APP_ID,
          },
        ],
      },
    }),
  };
}
export const remoteDesktopProvider = desktopProvider();

function validExecutable(binary: string, root: string) {
  try {
    if (!fs.lstatSync(binary).isFile() || fs.lstatSync(binary).isSymbolicLink()) return false;
    const canonicalRoot = fs.realpathSync(root);
    if (!fs.realpathSync(binary).startsWith(`${canonicalRoot}${path.sep}`)) return false;
    fs.accessSync(binary, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readNativeDesktopPackage(installBaseDir: string) {
  const root = path.resolve(managedNativeAppRoot(installBaseDir, DESKTOP_COMPONENT_APP_ID));
  const manifestFile = managedNativeAppManifestPath(installBaseDir, DESKTOP_COMPONENT_APP_ID);
  const manifest = readNativeAppManifest(installBaseDir, DESKTOP_COMPONENT_APP_ID);
  if (!manifest) {
    if (fs.existsSync(manifestFile) || fs.existsSync(root)) throw new Error("REMOTE_DESKTOP_PACKAGE_INVALID");
    return undefined;
  }
  const binary = path.resolve(root, manifest.launchPath);
  if (!binary.startsWith(`${root}${path.sep}`) || !manifest.files.includes(manifest.launchPath) || !validExecutable(binary, root)) {
    throw new Error("REMOTE_DESKTOP_PACKAGE_INVALID");
  }
  return { binary, version: manifest.version };
}

/** Legacy archives remain executable and uninstallable until the same App
 * transaction replaces them with the npm-distributed native package. */
function readArchiveDesktopPackage(installBaseDir: string, stateDir: string) {
  const root = path.resolve(installBaseDir, DESKTOP_COMPONENT_APP_ID);
  const manifestFile = path.join(stateDir, "manifests", `${DESKTOP_COMPONENT_APP_ID}.json`);
  if (!fs.existsSync(manifestFile) && !fs.existsSync(`${manifestFile}.transaction`) && !fs.existsSync(path.join(root, DESKTOP_COMPONENT_EXECUTABLE)) && !fs.existsSync(path.join(root, "desktop-component.json"))) return undefined;
  try {
    if (fs.existsSync(`${manifestFile}.transaction`)) throw new Error();
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const files = [DESKTOP_COMPONENT_EXECUTABLE, "desktop-component.json"];
    if (manifest.appId !== DESKTOP_COMPONENT_APP_ID || manifest.installRoot !== root || !Array.isArray(manifest.files) || files.some((file) => !manifest.files.includes(file))) throw new Error();
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error();
    const canonical = fs.realpathSync(root);
    const base = fs.realpathSync(installBaseDir);
    if (!canonical.startsWith(`${base}${path.sep}`)) throw new Error();
    for (const file of files) {
      const target = path.join(root, file);
      if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink() || !fs.realpathSync(target).startsWith(`${canonical}${path.sep}`)) throw new Error();
    }
    const metadata = z.object({ version: z.string().min(1) }).parse(JSON.parse(fs.readFileSync(path.join(root, "desktop-component.json"), "utf8")));
    const binary = path.join(root, DESKTOP_COMPONENT_EXECUTABLE);
    fs.accessSync(binary, fs.constants.X_OK);
    return { binary, version: metadata.version };
  } catch { throw new Error("REMOTE_DESKTOP_PACKAGE_INVALID"); }
}

/** Resolve only files owned by the managed component. Native npm layout wins
 * when both layouts exist during an interrupted or completed migration. */
export function readManagedDesktopPackage(installBaseDir: string, stateDir: string) {
  const nativePackage = readNativeDesktopPackage(installBaseDir);
  return nativePackage || readArchiveDesktopPackage(installBaseDir, stateDir);
}

/** Remove only files listed by the old archive ownership manifest. Unowned
 * files are preserved, and cleanup is skipped until the native package is
 * complete. */
export function removeLegacyManagedDesktopPackage(installBaseDir: string, stateDir: string) {
  try {
    if (!readNativeDesktopPackage(installBaseDir)) return false;
    const root = path.resolve(installBaseDir, DESKTOP_COMPONENT_APP_ID);
    const manifestFile = path.join(stateDir, "manifests", `${DESKTOP_COMPONENT_APP_ID}.json`);
    if (!fs.existsSync(manifestFile) || fs.existsSync(`${manifestFile}.transaction`)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { appId?: unknown; installRoot?: unknown; files?: unknown };
    if (manifest.appId !== DESKTOP_COMPONENT_APP_ID || manifest.installRoot !== root || !Array.isArray(manifest.files)) return false;
    const files = [...new Set(manifest.files.map((value) => path.resolve(root, String(value))))];
    if (!files.length || files.some((file) => !file.startsWith(`${root}${path.sep}`))) return false;
    for (const file of files) {
      try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    const directories = [...new Set(files.map((file) => path.dirname(file)))].sort((left, right) => right.length - left.length);
    for (const directory of directories) {
      try { fs.rmdirSync(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) return false; }
    }
    fs.rmSync(manifestFile, { force: true });
    return true;
  } catch {
    return false;
  }
}
