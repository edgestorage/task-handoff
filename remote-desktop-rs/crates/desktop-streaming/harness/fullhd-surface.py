import os,secrets,subprocess,tempfile,time,signal
from pathlib import Path
# Explicit isolated X11 fixture, never discover an existing product display.
reference_group=os.environ.get('G1_REFERENCE_CGROUP')
if reference_group:
 assert reference_group=='/sys/fs/cgroup/task-handoff-g1-reference'
 subprocess.run(['sudo','-n','tee',str(Path(reference_group,'cgroup.procs'))],input=str(os.getpid()).encode(),stdout=subprocess.DEVNULL,check=True)
 os.sched_setaffinity(0,{0,1,2,3})
 print('Reference process tree:4CPUs/4GiB',flush=True)
print('Owned reference PID='+str(os.getpid()),flush=True)
d=Path(tempfile.mkdtemp(prefix='th-g1-fullhd-'));auth=d/'Xauthority';auth.touch(mode=0o600)
display=':88'
assert not Path('/tmp/.X11-unix/X88').exists(), 'fixture display already in use'
subprocess.run(['xauth','-f',str(auth),'add',display,'.',secrets.token_hex(16)],check=True)
env=dict(os.environ,DISPLAY=display,XAUTHORITY=str(auth),LANG='C.UTF-8')
children=[]
try:
 x=subprocess.Popen(['Xvfb',display,'-screen','0','1920x1080x24','-nolisten','tcp','-noreset','-auth',str(auth)],env=env,start_new_session=True);children.append(x)
 for _ in range(100):
  if Path('/tmp/.X11-unix/X88').exists():break
  if x.poll() is not None:raise RuntimeError('fixture Xvfb died')
  time.sleep(.02)
 children.append(subprocess.Popen(['openbox'],env=env,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
 profile=os.environ.get('G1_BUILD_PROFILE','debug')
 assert profile in ['debug','release']
 binary=Path.home()/('.local/share/task-handoff-g1-tests/remote-desktop-g1/src/target/'+profile+'/desktop-test-host')
 children.append(subprocess.Popen([str(binary),'--browser-native'],env=env,start_new_session=True))
 print('Owned fullHD fixture DISPLAY=:88 AUTH='+str(auth),flush=True)
 end=time.monotonic()+min(1200,max(1,int(os.environ.get('G1_REFERENCE_SECONDS','180'))))
 while time.monotonic()<end and all(c.poll() is None for c in children):time.sleep(.2)
finally:
 for child in reversed(children):
  if child.poll() is None:
   try:os.killpg(child.pid,signal.SIGTERM)
   except ProcessLookupError:pass
 for child in children:
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
 auth.unlink(missing_ok=True);d.rmdir()
