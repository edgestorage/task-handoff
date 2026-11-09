"""Browser DataChannel -> native owned AppKit fixture acceptance; no pixels saved."""
import argparse,json,queue,subprocess,threading,time,os,signal
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for name in ['fixture','bcap','session','url','output']:p.add_argument('--'+name,required=True)
p.add_argument('--kill-target',choices=['component','host']);p.add_argument('--host-pid',type=int)
p.add_argument('--window',action='store_true')
p.add_argument('--cursor-check',action='store_true')
p.add_argument('--window-negative',choices=['minimize','close'])
a=p.parse_args();events=queue.Queue();trace=[];browser_trace=[];result={'ok':False}
fixture=subprocess.Popen([a.fixture,'300'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
def read():
 for line in fixture.stdout:
  try:d=json.loads(line)
  except json.JSONDecodeError:continue
  trace.append(d);events.put(d)
threading.Thread(target=read,daemon=True).start()
def until(test,seconds=5):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:d=events.get(timeout=max(.01,end-time.monotonic()))
  except queue.Empty:break
  if test(d):return d
 raise RuntimeError('fixture event deadline')
def command(action):
 fixture.stdin.write(json.dumps({'action':action})+'\n');fixture.stdin.flush()
 return until(lambda d:d['kind']=={'focus':'ready','clear':'cleared','snapshot':'snapshot','move':'moved','resize':'resized','occlude':'occluded','uncover':'uncovered','steal':'stolen','minimize':'minimized','close':'closed','cursorHide':'cursorHidden','cursorShow':'cursorShown'}[action])
def js(script):
 r=subprocess.run(['node',a.bcap,'exec','--session',a.session,'--url',a.url,'--script',script],capture_output=True,text=True,check=True,timeout=15)
 d=json.loads(r.stdout)
 browser_trace.append(d)
 if isinstance(d,dict) and d.get('ok') is False:raise RuntimeError('browser action failed: '+r.stdout)
 return d
poll="async function wait(test){const end=performance.now()+5000;while(performance.now()<end){if(await test())return;await new Promise(r=>setTimeout(r,40));}throw Error('browser condition deadline');}"
def focused():
 d=command('focus')
 if not d['active']:raise RuntimeError('owned fixture not frontmost')
 return d
try:
 until(lambda d:d['kind']=='ready' and d['active'])
 selection = "await wait(()=>Array.isArray(window.diagnostic.windows));const owned=window.diagnostic.windows.filter(w=>w.title==='G1 owned macOS input fixture'&&w.capturable);if(owned.length!==1)throw Error('owned window unavailable');window.harness.selectWindow(owned[0].windowRef);" if a.window else ""
 initial=js(poll+"const old=window.diagnostic.snapshot?.viewerSessionId;window.diagnostic.windows=null;document.querySelector('#connect').click();"+selection+"await wait(()=>window.diagnostic.snapshot?.viewerSessionId!==old&&window.diagnostic.snapshot?.phase==='active'&&window.diagnostic.channels.length===4&&window.diagnostic.decodedFrames>0);return {diagnostic:window.diagnostic,stats:await window.harness.stats(),size:[video.videoWidth,video.videoHeight]};")
 focused();js(poll+"document.querySelector('#resume').click();await wait(()=>window.diagnostic.inputEpoch!==null);return {epoch:window.diagnostic.inputEpoch};")
 click_points=[]
 for offset in [500,100,500]:
  before=command('snapshot');d=focused();r=d['rect'];display=r if a.window else d['display'];x=(r['x']+offset-display['x'])/(display['width']-1);y=(r['y']+200-display['y'])/(display['height']-1)
  js("const p="+json.dumps({'x':x,'y':y})+";const inputEpoch=window.diagnostic.inputEpoch;for(const down of [true,false]){if(!window.harness.send('input','button',{inputEpoch,...p,button:0,down}))throw Error('send failed');await new Promise(r=>setTimeout(r,30));}return {sent:true,diagnostic:window.diagnostic};")
  clicked=until(lambda d:d['mouseDowns']>before['mouseDowns'] and d['mouseUps']>before['mouseUps'])
  click_points.append({'expectedX':offset,'actualX':clicked['lastMouseX']})
  if abs(clicked['lastMouseX']-offset)>2:raise RuntimeError('native click used obsolete pointer coordinates')
 focused();before=command('snapshot');r=before['rect'];display=r if a.window else before['display'];x=(r['x']+100-display['x'])/(display['width']-1);y=(r['y']+200-display['y'])/(display['height']-1)
 js("const p="+json.dumps({'x':x,'y':y})+";if(!window.harness.send('input','wheel',{inputEpoch:window.diagnostic.inputEpoch,...p,deltaX:0,deltaY:80}))throw Error('wheel send failed');return {sent:true};")
 scrolled=until(lambda d:d['wheels']>before['wheels'])
 if abs(scrolled['lastMouseX']-100)>2:raise RuntimeError('wheel used obsolete pointer coordinates')
 focused();before=command('snapshot')
 js("const inputEpoch=window.diagnostic.inputEpoch;for(const down of [true,false]){if(!window.harness.send('input','key',{inputEpoch,code:'KeyA',down,repeat:false,modifiers:0}))throw Error('send failed');await new Promise(r=>setTimeout(r,30));}return {sent:true,diagnostic:window.diagnostic};")
 until(lambda d:d['keyDowns']>before['keyDowns'] and d['keyUps']>before['keyUps'])
 focused();command('clear')
 js(poll+"const n=window.diagnostic.textCommits;document.querySelector('#commit').value='中文・日本語・é・😀 mixed ASCII punctuation !?';document.querySelector('#commit').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));await wait(()=>window.diagnostic.textCommits>n);return {committed:true};")
 text=until(lambda d:d.get('expectedTextMatches'))
 paused=js(poll+"document.querySelector('#hidden').click();await wait(()=>window.diagnostic.snapshot.mediaPaused);await new Promise(r=>setTimeout(r,500));const before=window.diagnostic.decodedFrames;await new Promise(r=>setTimeout(r,800));const after=window.diagnostic.decodedFrames;if(before!==after)throw Error('frames during pause');return {before,after,epoch:window.diagnostic.inputEpoch,keyframes:(await window.harness.stats())[0].keyFramesDecoded};")
 resumed=js(poll+"const before="+str(paused['keyframes'])+";document.querySelector('#visible').click();await wait(async()=>!window.diagnostic.snapshot.mediaPaused&&(await window.harness.stats())[0].keyFramesDecoded>before);return {keyframes:(await window.harness.stats())[0].keyFramesDecoded,epoch:window.diagnostic.inputEpoch,stats:await window.harness.stats()};")
 metrics=js(poll+"const old=window.diagnostic.metricsReplies;document.querySelector('#metrics').click();await wait(()=>window.diagnostic.metricsReplies>old);return window.diagnostic.metrics;")
 if resumed['epoch'] is not None:raise RuntimeError('visibility resumed input without consent')
 result={'ok':False,'metrics':metrics,'initial':initial,'nativeClick':True,'clickPoints':click_points,'nativePhysicalKey':True,'nativeWheel':True,'unicodeMatches':text['expectedTextMatches'],'characters':text['characters'],'pause':paused,'resume':resumed}
 if a.cursor_check:
  if not a.window:raise RuntimeError('cursor diagnostic requires owned window')
  focused()
  js(poll+"document.querySelector('#resume').click();await wait(()=>diagnostic.inputEpoch!==null);const n=diagnostic.decodedFrames;window.harness.send('pointer','pointer',{inputEpoch:diagnostic.inputEpoch,x:200/639,y:80/391});await wait(()=>diagnostic.decodedFrames>n+5);const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(video,0,0);window._cursorShown=[...x.getImageData(196,76,40,40).data];return {sampled:true};")
  command('cursorHide')
  hidden=js(poll+"const n=diagnostic.decodedFrames;await wait(()=>diagnostic.decodedFrames>n+8);const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(video,0,0);const hidden=x.getImageData(196,76,40,40).data;let changed=0;for(let i=0;i<hidden.length;i+=4){if(Math.abs(hidden[i]-window._cursorShown[i])+Math.abs(hidden[i+1]-window._cursorShown[i+1])+Math.abs(hidden[i+2]-window._cursorShown[i+2])>150)changed++;}window._cursorHidden=[...hidden];if(changed<20)throw Error('remote cursor did not hide');return {changedPixels:changed};")
  command('cursorShow')
  shown=js(poll+"const n=diagnostic.decodedFrames;await wait(()=>diagnostic.decodedFrames>n+8);const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(video,0,0);const shown=x.getImageData(196,76,40,40).data;let changed=0;for(let i=0;i<shown.length;i+=4){if(Math.abs(shown[i]-window._cursorHidden[i])+Math.abs(shown[i+1]-window._cursorHidden[i+1])+Math.abs(shown[i+2]-window._cursorHidden[i+2])>150)changed++;}delete window._cursorShown;delete window._cursorHidden;if(changed<20)throw Error('remote cursor did not reappear');return {changedPixels:changed};")
  result['cursor']={'hidden':hidden,'shown':shown,'pixelsSaved':False}
 if a.window_negative:
  if not a.window:raise RuntimeError('window target required')
  window_checks=[]
  def resume():
   focused()
   return js(poll+"diagnostic.error=null;document.querySelector('#resume').click();await wait(()=>diagnostic.inputEpoch!==null||diagnostic.error!==null);if(diagnostic.inputEpoch===null)throw Error(diagnostic.error);return {epoch:diagnostic.inputEpoch,revision:diagnostic.snapshot.sessionRevision};")
  for action in ['move','resize']:
   old=resume();before=command('snapshot')
   js("const inputEpoch=diagnostic.inputEpoch;window.harness.send('input','key',{inputEpoch,code:'KeyA',down:true,repeat:false,modifiers:0});return {sent:true};")
   until(lambda d:d['keyDowns']>before['keyDowns'])
   command(action)
   until(lambda d:d['keyUps']>before['keyUps'])
   changed=js(poll+"await wait(()=>diagnostic.snapshot.sessionRevision>"+str(old['revision'])+"&&diagnostic.inputEpoch===null);return {snapshot:diagnostic.snapshot};")
   js(poll+"diagnostic.error=null;window.harness.send('control','input.resume',{sessionRevision:"+str(old['revision'])+"});await wait(()=>diagnostic.error!==null);if(diagnostic.error!=='REMOTE_DESKTOP_STALE_EPOCH')throw Error(diagnostic.error);return {staleRejected:true};")
   resume()
   window_checks.append({'action':action,'released':True,'staleRevisionRejected':True,'snapshot':changed})
   js("window.harness.suspend();return {suspended:true};")
  resume();command('steal')
  js(poll+"await wait(()=>diagnostic.inputEpoch===null);if(diagnostic.snapshot.phase!=='active')throw Error('media failed on focus loss');return {focusSuspended:true};")
  command('uncover');resume()
  command('occlude')
  js(poll+"const old=diagnostic.decodedFrames;window.harness.send('pointer','pointer',{inputEpoch:diagnostic.inputEpoch,x:0.5,y:0.5});await wait(()=>diagnostic.inputEpoch===null);await wait(()=>diagnostic.decodedFrames>old);if(diagnostic.error!=='REMOTE_DESKTOP_WINDOW_FOCUS_REQUIRED')throw Error('occlusion not reported');return {occlusionSuspended:true,mediaContinues:true};")
  command('uncover');resume()
  command(a.window_negative)
  terminal=js(poll+"await wait(()=>diagnostic.snapshot.phase==='failed');if(diagnostic.inputEpoch!==null)throw Error('terminal input armed');return {reason:diagnostic.snapshot.reason};")
  if terminal['reason']!='REMOTE_DESKTOP_WINDOW_UNAVAILABLE':raise RuntimeError('wrong closed/minimized reason')
  result['windowLifecycle']={'geometry':window_checks,'focusLoss':True,'occlusion':True,'terminal':a.window_negative,'reason':terminal['reason']}
 if a.kill_target:
  if not a.host_pid:raise RuntimeError('explicit owned host PID required')
  host_args=subprocess.check_output(['ps','-p',str(a.host_pid),'-o','args='],text=True).strip()
  if 'desktop-test-host --browser-native' not in host_args:raise RuntimeError('host identity mismatch')
  children=subprocess.check_output(['pgrep','-P',str(a.host_pid)],text=True).split()
  component=[]
  for candidate in children:
   args=subprocess.check_output(['ps','-p',candidate,'-o','args='],text=True).strip()
   if 'task-handoff-desktop-streaming --native' in args:component.append(int(candidate))
  if len(component)!=1:raise RuntimeError('owned component identity ambiguous')
  component=component[0]
  guard=[]
  for candidate in subprocess.check_output(['pgrep','-P',str(component)],text=True).split():
   args=subprocess.check_output(['ps','-p',candidate,'-o','args='],text=True).strip()
   if 'task-handoff-desktop-streaming --input-guard' in args:guard.append(int(candidate))
  if len(guard)!=1:raise RuntimeError('owned guard identity ambiguous')
  focused();before=command('snapshot');r=before['rect'];display=r if a.window else before['display'];x=(r['x']+100-display['x'])/(display['width']-1);y=(r['y']+200-display['y'])/(display['height']-1)
  js(poll+"document.querySelector('#resume').click();await wait(()=>window.diagnostic.inputEpoch!==null);return {epoch:window.diagnostic.inputEpoch};")
  focused()
  js("const p="+json.dumps({'x':x,'y':y})+";const inputEpoch=window.diagnostic.inputEpoch;for(const [type,payload] of [['key',{code:'KeyA',down:true,repeat:false,modifiers:0}],['button',{...p,button:0,down:true}]]){if(!window.harness.send('input',type,{inputEpoch,...payload}))throw Error('hold send failed');}return {held:true};")
  until(lambda d:d['keyDowns']>before['keyDowns'] and d['mouseDowns']>before['mouseDowns'])
  killed=time.monotonic();os.kill(component if a.kill_target=='component' else a.host_pid,signal.SIGKILL)
  released=until(lambda d:d['keyUps']>before['keyUps'] and d['mouseUps']>before['mouseUps'],seconds=2)
  release_ms=(time.monotonic()-killed)*1000
  end=time.monotonic()+5
  remaining=[]
  while time.monotonic()<end:
   remaining=[]
   for candidate in [component,guard[0]]:
    status=subprocess.run(['ps','-p',str(candidate),'-o','stat='],capture_output=True,text=True).stdout.strip()
    if status and not status.startswith('Z'):remaining.append(candidate)
   if not remaining:break
   time.sleep(.05)
  if remaining:raise RuntimeError('owned component/guard survived parent death')
  result['strongKill']={'target':a.kill_target,'keyReleased':True,'buttonReleased':True,'releaseMs':release_ms,'ownedChildrenExited':True}

 result['ok']=True
finally:
 try:js("return {final:window.diagnostic,stats:await window.harness.stats().catch(()=>[])};");js("document.querySelector('#stop').click();return {stopping:true};")
 finally:
  if fixture.poll() is None:
   fixture.stdin.write('{"action":"quit"}\n');fixture.stdin.flush()
   try:fixture.wait(timeout=5)
   except subprocess.TimeoutExpired:fixture.terminate();fixture.wait(timeout=2)
  def redact(value):
   if isinstance(value,list):return [redact(item) for item in value]
   if isinstance(value,dict):return {key:({'count':len(item),'capturable':sum(bool(w.get('capturable')) for w in item)} if key=='windows' and isinstance(item,list) else redact(item)) for key,item in value.items()}
   return value
  Path(a.output).write_text(json.dumps(redact({'result':result,'trace':trace,'browserTrace':browser_trace}),indent=2)+'\n')
  print(json.dumps({'ok':result['ok'],'nativeClick':result.get('nativeClick'),'nativePhysicalKey':result.get('nativePhysicalKey'),'unicodeMatches':result.get('unicodeMatches'),'pause':result.get('pause'),'resume':result.get('resume'),'strongKill':result.get('strongKill')}))
