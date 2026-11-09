/** Private installer journal. A crash before journal removal rolls back to the
 * previous complete tree and ownership manifest. Never replay a download/job. */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "@task-handoff/core/storage/atomic-write";

type Journal = { root: string; staging: string; hadRoot: boolean; oldManifest: string | null };
function checkedJournal(file: string, base: string): Journal {
  const raw: unknown = JSON.parse(fs.readFileSync(file,"utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid archive transaction.");
  const j = raw as Journal;
  if (typeof j.root !== "string" || typeof j.staging !== "string" || typeof j.hadRoot !== "boolean" || (j.oldManifest !== null && typeof j.oldManifest !== "string")) throw new Error("Invalid archive transaction.");
  const resolvedBase = path.resolve(base);
  if (!path.resolve(j.root).startsWith(`${resolvedBase}${path.sep}`) || path.dirname(j.root) !== path.dirname(j.staging) || !path.basename(j.staging).startsWith(".install-") || !fs.lstatSync(j.staging).isDirectory() || fs.lstatSync(j.staging).isSymbolicLink()) throw new Error("Invalid archive transaction paths.");
  const realBase = fs.realpathSync(resolvedBase);
  const parent = fs.realpathSync(path.dirname(j.root));
  if (parent !== realBase && !parent.startsWith(`${realBase}${path.sep}`)) throw new Error("Archive transaction escapes install root.");
  return j;
}
export function recoverArchiveTransaction(file: string, base: string) {
  const j = checkedJournal(file,base);
  const previous = path.join(j.staging,"previous");
  if (j.hadRoot && fs.existsSync(previous)) {
    fs.rmSync(j.root,{recursive:true,force:true}); fs.renameSync(previous,j.root);
  } else if (!j.hadRoot) fs.rmSync(j.root,{recursive:true,force:true});
  else if (!fs.existsSync(j.root)) throw new Error("Archive rollback tree is missing.");
  const manifest = file.slice(0,-".transaction".length);
  if (j.oldManifest === null) fs.rmSync(manifest,{force:true});
  else atomicWriteJsonSync(manifest,JSON.parse(j.oldManifest));
  fs.unlinkSync(file);
  fs.rmSync(j.staging,{recursive:true,force:true});
}
export function recoverArchiveTransactions(stateDir: string, base: string) {
  const directory=path.join(stateDir,"manifests");
  const failures: string[] = [];
  if (!fs.existsSync(directory)) return failures;
  for (const name of fs.readdirSync(directory)) if (name.endsWith(".json.transaction")) {
    try { recoverArchiveTransaction(path.join(directory,name),base); }
    catch { failures.push(name.slice(0,-".json.transaction".length)); }
  }
  return failures;
}
export function commitArchiveTransaction(input: { root:string; staging:string; candidate:string; manifestFile:string; manifest:unknown }, base:string) {
  const file = `${input.manifestFile}.transaction`;
  if (fs.existsSync(file)) recoverArchiveTransaction(file,base);
  const journal: Journal = { root:input.root, staging:input.staging, hadRoot:fs.existsSync(input.root), oldManifest:fs.existsSync(input.manifestFile) ? fs.readFileSync(input.manifestFile,"utf8") : null };
  atomicWriteJsonSync(file,journal);
  try {
    if (journal.hadRoot) fs.renameSync(input.root,path.join(input.staging,"previous"));
    fs.renameSync(input.candidate,input.root);
    if(input.manifest===null)fs.rmSync(input.manifestFile,{force:true});
    else atomicWriteJsonSync(input.manifestFile,input.manifest);
    fs.unlinkSync(file); // commit marker: rollback is no longer needed
  } catch (error) { recoverArchiveTransaction(file,base); throw error; }
}
