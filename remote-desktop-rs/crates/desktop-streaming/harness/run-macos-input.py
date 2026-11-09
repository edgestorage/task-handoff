"""Owned AppKit fixture + native guard acceptance. Never targets user apps."""
import argparse,json,queue,subprocess,threading,time,os
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--fixture',required=True);p.add_argument('--probe',required=True);p.add_argument('--output',required=True)
a=p.parse_args();events=queue.Queue();trace=[];holding=None
fixture=subprocess.Popen([a.fixture,'300'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
def read():
 for line in fixture.stdout:
  try:d=json.loads(line)
  except json.JSONDecodeError:continue
  d['receivedMonotonic']=time.monotonic();trace.append(d);events.put(d)
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
 return until(lambda d:d['kind']=={'focus':'ready','clear':'cleared','snapshot':'snapshot'}[action])
def focus():
 d=command('focus')
 if not d['active']:raise RuntimeError('owned fixture not frontmost')
 return d
result={'ok':False}
try:
 ready=until(lambda d:d['kind']=='ready' and d['active']);pid=ready['pid']
 def run(action):
  d=focus();r=d['rect'];display=d['display'];x=(r['x']+100-display['x'])/(display['width']-1);y=(r['y']+200-display['y'])/(display['height']-1)
  # Both fixture and guard derive coordinates from the authoritative display.
  argv=[a.probe,action,str(x),str(y),str(pid)]
  return subprocess.run(argv,capture_output=True,text=True,timeout=8,check=True)
 before=command('snapshot');run('click');time.sleep(.15);clicked=command('snapshot')
 if clicked['mouseDowns']!=before['mouseDowns']+1 or clicked['mouseUps']!=before['mouseUps']+1:raise RuntimeError('native click missing')
 before=command('snapshot');run('key');time.sleep(.15);keyed=command('snapshot')
 if keyed['keyDowns']<=before['keyDowns'] or keyed['keyUps']<=before['keyUps']:raise RuntimeError('physical key missing')
 command('clear');run('text');time.sleep(.2);text=command('snapshot')
 if not text['expectedTextMatches']:raise RuntimeError('native Unicode bytes differ')
 command('clear');before=command('snapshot');run('watchdog-key');released=command('snapshot')
 if released['keyUps']<=before['keyUps']:raise RuntimeError('independent watchdog did not release key')
 kill_results={}
 for action,down_field,up_field in [('hold-key','keyDowns','keyUps'),('hold-button','mouseDowns','mouseUps')]:
  command('clear');d=focus();before=command('snapshot');r=d['rect'];display=d['display'];x=(r['x']+100-display['x'])/(display['width']-1);y=(r['y']+200-display['y'])/(display['height']-1)
  holding=subprocess.Popen([a.probe,action,str(x),str(y),str(pid)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  import selectors
  selector=selectors.DefaultSelector();selector.register(holding.stdout,selectors.EVENT_READ)
  if not selector.select(timeout=5):raise RuntimeError('held-input acknowledgement missing')
  held=json.loads(holding.stdout.readline());selector.close()
  if not held.get('held'):raise RuntimeError('hold failed')
  until(lambda d:d[down_field]>before[down_field])
  killed=time.monotonic();holding.kill();holding.wait(timeout=2)
  up=until(lambda d:d[up_field]>before[up_field],seconds=1)
  release_ms=(up['receivedMonotonic']-killed)*1000
  time.sleep(.2)
  status=subprocess.run(['ps','-p',str(held['guardPid']),'-o','stat='],capture_output=True,text=True).stdout.strip()
  if status:raise RuntimeError('guard process remains after parent death')
  kill_results[action]={'released':True,'releaseMs':release_ms,'guardExited':True}
 result={'ok':True,'click':True,'physicalKey':True,'unicodeMatches':text['expectedTextMatches'],'characters':text['characters'],'watchdogReleased':True,'parentSigkillReleased':True,'parentSigkillReleaseMs':kill_results['hold-key']['releaseMs'],'guardExited':True,'parentSigkillCases':kill_results}
finally:
 if holding and holding.poll() is None:holding.kill();holding.wait(timeout=2);time.sleep(1.8)
 if fixture.poll() is None:
  fixture.stdin.write('{"action":"quit"}\n');fixture.stdin.flush()
  try:fixture.wait(timeout=5)
  except subprocess.TimeoutExpired:fixture.terminate();fixture.wait(timeout=2)
 Path(a.output).write_text(json.dumps({'result':result,'trace':trace},indent=2)+'\n')
 print(json.dumps(result))
