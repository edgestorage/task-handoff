const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText,filename);
const {resolveRegistryNativePackage}=require('../packages/app-runtime/src/registry-native-package.ts');

const integrity=`sha512-${Buffer.alloc(64,7).toString('base64')}`;
const recipe={type:'registry-native-package',platforms:['linux'],arches:['x64','arm64'],libc:'gnu',privilege:'user',packagePrefix:'@task-handoff/remote-desktop',distTag:'latest',launchPath:'bin/task-handoff-desktop-streaming'};
const capabilities={platform:'linux',arch:'arm64',installers:[],privilege:'user'};
const packageName='@task-handoff/remote-desktop-linux-arm64';
const encodedPackageName='%40task-handoff%2Fremote-desktop-linux-arm64';
const tarballUrl='https://registry.example/@task-handoff/remote-desktop-linux-arm64/-/remote-desktop-linux-arm64-1.2.3.tgz';
const exactMetadata={name:packageName,version:'1.2.3',dist:{integrity,tarball:tarballUrl}};
const metadata={name:packageName,'dist-tags':{latest:'1.2.3'},versions:{'1.2.3':exactMetadata}};

test('registry native recipes resolve latest to an exact package, URL and integrity',async()=>{
 const requests=[];
 const result=await resolveRegistryNativePackage(recipe,capabilities,{registries:['https://registry.example'],fetch:async(url,init)=>{
  requests.push([String(url),init]);
  return new Response(JSON.stringify(requests.length===1?metadata:exactMetadata),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.equal(requests.length,2);
 assert.equal(requests[0][0],`https://registry.example/${encodedPackageName}`);
 assert.equal(requests[1][0],`https://registry.example/${encodedPackageName}/1.2.3`);
 assert.deepEqual(result,{
  type:'native-package',platforms:['linux'],arches:['arm64'],libc:'gnu',privilege:'user',package:packageName,packageVersion:'1.2.3',version:'1.2.3',integrity,launchPath:'bin/task-handoff-desktop-streaming',tarballUrl,
 });
 assert.notEqual(result.packageVersion,'latest');
});

test('registry native package discovery falls back only after a complete primary failure',async()=>{
 const requested=[];
 const result=await resolveRegistryNativePackage(recipe,capabilities,{registries:['https://primary.example','https://fallback.example'],fetch:async url=>{
  requested.push(String(url));
  if(String(url).startsWith('https://primary.example'))return new Response('unavailable',{status:503});
  return new Response(JSON.stringify(String(url).endsWith('/1.2.3')?exactMetadata:metadata),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.equal(result.version,'1.2.3');
 assert.equal(result.tarballUrl,tarballUrl);
 assert.deepEqual(requested,[
  `https://primary.example/${encodedPackageName}`,
  `https://fallback.example/${encodedPackageName}`,
  `https://fallback.example/${encodedPackageName}/1.2.3`,
 ]);
});

test('an explicit registry remains primary while public fallbacks remain available',async()=>{
 const requested=[];
 const result=await resolveRegistryNativePackage(recipe,capabilities,{registries:['https://configured.example'],fetch:async url=>{
  requested.push(String(url));
  if(String(url).startsWith('https://configured.example'))return new Response('unavailable',{status:503});
  if(String(url).startsWith('https://registry.npmjs.org'))return new Response('unavailable',{status:503});
  return new Response(JSON.stringify(String(url).endsWith('/1.2.3')?exactMetadata:metadata),{status:200});
 }});
 assert.equal(result.version,'1.2.3');
 assert.deepEqual(requested,[
  `https://configured.example/${encodedPackageName}`,
  `https://registry.npmjs.org/${encodedPackageName}`,
  `https://registry.npmmirror.com/${encodedPackageName}`,
  `https://registry.npmmirror.com/${encodedPackageName}/1.2.3`,
 ]);
});

test('registry resolution rejects incomplete or mutable metadata',async()=>{
 await assert.rejects(
  ()=>resolveRegistryNativePackage(recipe,capabilities,{
   registries:['https://registry.example'],
   fetch:async url=>new Response(JSON.stringify(String(url).endsWith('/1.2.3')?{...exactMetadata,dist:{tarball:tarballUrl}}:metadata),{status:200}),
  }),
  /integrity/,
 );
 await assert.rejects(
  ()=>resolveRegistryNativePackage(recipe,capabilities,{
   registries:['https://registry.example'],
   fetch:async url=>new Response(JSON.stringify(String(url).endsWith('/1.2.3')?{...exactMetadata,dist:{...exactMetadata.dist,integrity:`sha512-${Buffer.alloc(64,8).toString('base64')}`}}:metadata),{status:200}),
  }),
  /changed/,
 );
 await assert.rejects(
  ()=>resolveRegistryNativePackage(recipe,{...capabilities,platform:'freebsd'},{
   registries:['https://registry.example'],
   fetch:async()=>assert.fail('fetch must not run'),
  }),
  /does not support/,
 );
});

test('registry native recipes resolve Windows x64 package names',async()=>{
 const windowsName='@task-handoff/remote-desktop-win32-x64';
 const windowsRecipe={...recipe,platforms:['win32'],arches:['x64'],launchPath:'bin/task-handoff-desktop-streaming.exe'};
 const windowsMetadata={name:windowsName,'dist-tags':{latest:'1.2.3'},versions:{'1.2.3':{name:windowsName,version:'1.2.3',dist:{integrity,tarball:'https://registry.example/task-handoff-remote-desktop-win32-x64-1.2.3.tgz'}}}};
 const result=await resolveRegistryNativePackage(windowsRecipe,{platform:'win32',arch:'x64',installers:[],privilege:'user'},{registries:['https://registry.example'],fetch:async url=>new Response(JSON.stringify(String(url).endsWith('/1.2.3')?windowsMetadata.versions['1.2.3']:windowsMetadata),{status:200})});
 assert.equal(result.platforms[0],'win32');
 assert.equal(result.arches[0],'x64');
 assert.equal(result.package,windowsName);
 assert.equal(result.launchPath,'bin/task-handoff-desktop-streaming.exe');
});

test('registry resolution rejects non-HTTPS tarballs',async()=>{
 await assert.rejects(
  ()=>resolveRegistryNativePackage(recipe,capabilities,{
   registries:['https://registry.example'],
   fetch:async url=>new Response(JSON.stringify(String(url).endsWith('/1.2.3')?{...exactMetadata,dist:{...exactMetadata.dist,tarball:'http://registry.example/package.tgz'}}:metadata),{status:200}),
  }),
  /canonical HTTPS tarball/,
 );
});

test('registry metadata redirects cannot leave HTTPS',async()=>{
 const requested=[];
 await assert.rejects(
  ()=>resolveRegistryNativePackage(recipe,capabilities,{
   registries:['https://registry.example'],
   fetch:async url=>{
    requested.push(String(url));
    if(String(url).startsWith('https://registry.example'))return new Response(null,{status:302,headers:{location:'http://registry.example/package'}});
    return new Response('unavailable',{status:503});
   },
  }),
  /redirects must use HTTPS/,
 );
 assert.equal(requested.some(url=>url.startsWith('http://')),false);
});
