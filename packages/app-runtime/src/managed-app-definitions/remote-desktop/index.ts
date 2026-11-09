import fs from "node:fs";
import path from "node:path";
import { controlledInstancePackageVersionResolver } from "@task-handoff/core/core/package-version";
import { z } from "zod";
import release from "../../../../../shared/remote-desktop-artifacts.json";
import type { ManagedAppProvider } from "../types";

// Immutable release input, populated by the G6 artifact build after validation.
// No URL/hash is guessed, and no missing artifact falls back to a host command.
const Artifact = z.object({ version: z.string(), platform: z.enum(["linux","darwin"]), arch: z.enum(["x64","arm64"]), url: z.url().refine((url) => { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash; }), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type DesktopArtifact = z.infer<typeof Artifact>;
export const DESKTOP_COMPONENT_APP_ID = "remote-desktop";
export const DESKTOP_COMPONENT_EXECUTABLE = "bin/task-handoff-desktop-streaming";
export function desktopProvider(artifacts: unknown = release.artifacts): ManagedAppProvider {
  const parsed = z.array(Artifact).safeParse(artifacts);
  const validated = parsed.success ? parsed.data : [];
  return {
    id: DESKTOP_COMPONENT_APP_ID,
    definition: ({env}) => {
      const version = controlledInstancePackageVersionResolver(env)();
      return {
        launcher: { id:DESKTOP_COMPONENT_APP_ID, name:"Remote Desktop", kind:"tty", command:DESKTOP_COMPONENT_EXECUTABLE, description:"Optional instance desktop streaming component." },
        launchable:false,
        detection:[{type:"launcher-executable",versionArgs:["--version"]}],
        distribution:{ recipes: [{type:"archive-ownership" as const,platforms:["linux" as const,"darwin" as const],arches:["x64" as const,"arm64" as const],privilege:"user" as const,installRoot:DESKTOP_COMPONENT_APP_ID}, ...validated.filter((entry) => entry.version === version).map((entry) => ({type:"archive" as const, platforms:[entry.platform], arches:[entry.arch], privilege:"user" as const, url:entry.url, sha256:entry.sha256, format:"tar.gz" as const, installRoot:DESKTOP_COMPONENT_APP_ID}))] },
      };
    },
  };
}
export const remoteDesktopProvider = desktopProvider();

/** The artifact owns its version metadata; the installer owns its file list.
 * Neither is a public session field or a second installation registry. */
export function readManagedDesktopPackage(installBaseDir: string, stateDir: string) {
  const root = path.resolve(installBaseDir,DESKTOP_COMPONENT_APP_ID);
  const manifestFile = path.join(stateDir,"manifests",`${DESKTOP_COMPONENT_APP_ID}.json`);
  if (!fs.existsSync(manifestFile) && !fs.existsSync(`${manifestFile}.transaction`) && !fs.existsSync(path.join(root,DESKTOP_COMPONENT_EXECUTABLE)) && !fs.existsSync(path.join(root,"desktop-component.json"))) return undefined;
  try {
    if (fs.existsSync(`${manifestFile}.transaction`)) throw new Error();
    const manifest = JSON.parse(fs.readFileSync(manifestFile,"utf8"));
    const files = [DESKTOP_COMPONENT_EXECUTABLE,"desktop-component.json"];
    if (manifest.appId !== DESKTOP_COMPONENT_APP_ID || manifest.installRoot !== root || !Array.isArray(manifest.files) || files.some((file)=>!manifest.files.includes(file))) throw new Error();
    if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error();
    const canonical = fs.realpathSync(root);
    const base = fs.realpathSync(installBaseDir);
    if (!canonical.startsWith(`${base}${path.sep}`)) throw new Error();
    for (const file of files) {
      const target = path.join(root,file);
      if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink() || !fs.realpathSync(target).startsWith(`${canonical}${path.sep}`)) throw new Error();
    }
    const metadata = z.object({version:z.string().min(1)}).parse(JSON.parse(fs.readFileSync(path.join(root,"desktop-component.json"),"utf8")));
    const binary = path.join(root,DESKTOP_COMPONENT_EXECUTABLE);
    fs.accessSync(binary,fs.constants.X_OK);
    return { binary, version:metadata.version };
  } catch { throw new Error("REMOTE_DESKTOP_PACKAGE_INVALID"); }
}
