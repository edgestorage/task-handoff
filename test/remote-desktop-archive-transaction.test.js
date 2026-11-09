const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
require("./workspace-require.js").registerWorkspaceRequire();
require.extensions[".ts"]=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText,filename);
const { commitArchiveTransaction, recoverArchiveTransactions }=require("../packages/controlled-instance/src/web/archive-transaction.ts");
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"desktop-swap-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const base=path.join(dir,"apps"),root=path.join(base,"tool"),state=path.join(dir,"state"),manifestFile=path.join(state,"manifests","tool.json");
  fs.mkdirSync(root,{recursive:true}); fs.mkdirSync(path.dirname(manifestFile),{recursive:true});
  fs.writeFileSync(path.join(root,"binary"),"old");fs.writeFileSync(path.join(root,"unowned"),"user");
  const oldManifest={installRoot:root,files:["binary"]};fs.writeFileSync(manifestFile,JSON.stringify(oldManifest));
  const staging=fs.mkdtempSync(path.join(base,".install-tool-")),candidate=path.join(staging,"candidate");fs.mkdirSync(candidate);fs.writeFileSync(path.join(candidate,"binary"),"new");
  return {base,root,state,manifestFile,staging,candidate,oldManifest};
}
test("archive transaction commits a complete tree and manifest together",t=>{
  const f=fixture(t); const manifest={installRoot:f.root,files:["binary"],release:"new"};
  commitArchiveTransaction({...f,manifest},f.base);
  assert.equal(fs.readFileSync(path.join(f.root,"binary"),"utf8"),"new");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifestFile,"utf8")),manifest);
  assert.equal(fs.existsSync(`${f.manifestFile}.transaction`),false);
});
for(const boundary of ["before-move","old-moved","new-moved","manifest-written"]) test(`archive restart restores previous complete state after ${boundary}`,t=>{
  const f=fixture(t);
  fs.writeFileSync(`${f.manifestFile}.transaction`,JSON.stringify({root:f.root,staging:f.staging,hadRoot:true,oldManifest:JSON.stringify(f.oldManifest)}));
  if(boundary!=="before-move")fs.renameSync(f.root,path.join(f.staging,"previous"));
  if(["new-moved","manifest-written"].includes(boundary))fs.renameSync(f.candidate,f.root);
  if(boundary==="manifest-written")fs.writeFileSync(f.manifestFile,JSON.stringify({files:["new"]}));
  assert.deepEqual(recoverArchiveTransactions(f.state,f.base),[]);
  assert.equal(fs.readFileSync(path.join(f.root,"binary"),"utf8"),"old");
  assert.equal(fs.readFileSync(path.join(f.root,"unowned"),"utf8"),"user");
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifestFile,"utf8")),f.oldManifest);
  assert.deepEqual(recoverArchiveTransactions(f.state,f.base),[]);
});
test("failed first-install recovery removes an uncommitted tree and remains idempotent",t=>{
  const f=fixture(t);fs.rmSync(f.root,{recursive:true});fs.rmSync(f.manifestFile);
  fs.writeFileSync(`${f.manifestFile}.transaction`,JSON.stringify({root:f.root,staging:f.staging,hadRoot:false,oldManifest:null}));
  fs.renameSync(f.candidate,f.root);
  assert.deepEqual(recoverArchiveTransactions(f.state,f.base),[]);
  assert.equal(fs.existsSync(f.root),false);assert.equal(fs.existsSync(f.manifestFile),false);
});
test("malformed transaction remains unavailable and cannot remove paths outside managed root",t=>{
  const f=fixture(t);fs.writeFileSync(`${f.manifestFile}.transaction`,JSON.stringify({root:path.dirname(f.base),staging:f.staging,hadRoot:false,oldManifest:null}));
  assert.deepEqual(recoverArchiveTransactions(f.state,f.base),["tool"]);
  assert.equal(fs.readFileSync(path.join(f.root,"binary"),"utf8"),"old");
  assert.equal(fs.existsSync(`${f.manifestFile}.transaction`),true);
});

test("archive uninstall commits ownership removal while retaining a complete unowned tree",t=>{
 const f=fixture(t);fs.rmSync(path.join(f.candidate,"binary"));fs.writeFileSync(path.join(f.candidate,"unowned"),"user");
 commitArchiveTransaction({...f,manifest:null},f.base);
 assert.equal(fs.existsSync(f.manifestFile),false);assert.equal(fs.existsSync(path.join(f.root,"binary")),false);
 assert.equal(fs.readFileSync(path.join(f.root,"unowned"),"utf8"),"user");
});
test("restart during uninstall restores owned files and ownership after manifest removal",t=>{
 const f=fixture(t);fs.writeFileSync(`${f.manifestFile}.transaction`,JSON.stringify({root:f.root,staging:f.staging,hadRoot:true,oldManifest:JSON.stringify(f.oldManifest)}));
 fs.renameSync(f.root,path.join(f.staging,"previous"));fs.renameSync(f.candidate,f.root);fs.rmSync(f.manifestFile);
 assert.deepEqual(recoverArchiveTransactions(f.state,f.base),[]);
 assert.equal(fs.readFileSync(path.join(f.root,"binary"),"utf8"),"old");assert.deepEqual(JSON.parse(fs.readFileSync(f.manifestFile,"utf8")),f.oldManifest);
});
