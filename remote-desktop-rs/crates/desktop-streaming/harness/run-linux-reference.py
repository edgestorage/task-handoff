"""Bounded G1 diagnostic benchmark on the explicitly permitted .109 host.
Requires the isolated release build and bcap script library from this worktree.
Owns :88 and one fixed test cgroup; never discovers a product/user display.
"""
import argparse,json,os,queue,re,subprocess,threading,time
from pathlib import Path

HOST='huadream@192.168.139.109'
BASE='.local/share/task-handoff-g1-tests/remote-desktop-g1'
GROUP='/sys/fs/cgroup/task-handoff-g1-reference'

def ssh(command, **kwargs):
    return subprocess.Popen(['ssh','-o','BatchMode=yes',HOST,command], **kwargs)

def checked(command):
    return subprocess.run(['ssh','-o','BatchMode=yes',HOST,command],check=True,capture_output=True,text=True).stdout

def event(**values):
    print(json.dumps(values),flush=True)

def run(args, mode):
    out=Path(args.output_root)/mode
    out.mkdir(parents=True,exist_ok=False)
    # Assert ownership resources are absent. Do not repair/remove unknown owners.
    checked(f'test ! -e {GROUP} && test ! -S /tmp/.X11-unix/X88')
    command=f'''set -eu
sudo -n mkdir {GROUP}
trap 'sudo -n rmdir {GROUP}' EXIT
printf '0-3' | sudo -n tee {GROUP}/cpuset.cpus >/dev/null
printf '0' | sudo -n tee {GROUP}/cpuset.mems >/dev/null
printf '400000 100000' | sudo -n tee {GROUP}/cpu.max >/dev/null
printf '4294967296' | sudo -n tee {GROUP}/memory.max >/dev/null
G1_DESKTOP_INPUT_TRACE=1 G1_REFERENCE_CGROUP={GROUP} G1_REFERENCE_SECONDS=600 G1_BUILD_PROFILE=release python3 {BASE}/fullhd-surface.py
'''
    lines=queue.Queue()
    host=ssh(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
    def reader():
        with (out/'host.log').open('w') as log:
            for line in host.stdout:
                log.write(line);log.flush();lines.put(line)
    threading.Thread(target=reader,daemon=True).start()
    parent=port=auth=target_id=None
    forward=gui=sampler=None
    try:
        deadline=time.monotonic()+30
        while not all([parent,port,auth]):
            line=lines.get(timeout=max(.1,deadline-time.monotonic()))
            if m:=re.search(r'Owned reference PID=(\d+)',line):parent=int(m[1])
            if m:=re.search(r'Synthetic G1 harness: http://127.0.0.1:(\d+)',line):port=int(m[1])
            if m:=re.search(r'AUTH=(/tmp/th-g1-fullhd-[\w-]+/Xauthority)',line):auth=m[1]
            if time.monotonic()>deadline:raise RuntimeError('host readiness deadline')
        forward=subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-N','-L',f'{port}:127.0.0.1:{port}',HOST],stdout=subprocess.DEVNULL,stderr=(out/'forward.log').open('w'))
        # SSH has no readiness event; bounded connect attempts are test setup only.
        import socket
        for _ in range(50):
            if forward.poll() is not None:raise RuntimeError('forward exited')
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.2):break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('forward readiness deadline')
        gui=ssh(f'DISPLAY=:88 XAUTHORITY={auth} {BASE}/src/target/release/desktop-x11-gui-fixture {mode} 360',stdout=(out/'gui.log').open('w'),stderr=subprocess.STDOUT)
        created=subprocess.run(['node','scripts/bcap.mjs','new',f'http://127.0.0.1:{port}/','--session',args.session],cwd=args.bcap_root,capture_output=True,text=True,check=True,timeout=10)
        target_id=json.loads(created.stdout)['targetId']
        def measure(name, values):
            values['receiverSlowdown']=args.receiver_slowdown
            command=['node','scripts/bcap.mjs','run',f'sites/127.0.0.1/measure-desktop-{args.measurement}.js','--session',args.session]
            command+=['--tab',target_id]
            command+=['--input',json.dumps(values),'--timeout','115000']
            with (out/(name+'.json')).open('w') as output:
                result=subprocess.run(command,cwd=args.bcap_root,stdout=output,stderr=subprocess.PIPE,text=True,timeout=120)
            if result.returncode:raise RuntimeError(result.stderr or (out/(name+'.json')).read_text())
            data=json.loads((out/(name+'.json')).read_text())
            if not data.get('ok'):raise RuntimeError('benchmark returned failure')
            return data
        warm=measure('warmup',{'connect':True,'seconds':1,'samples':1,'receiverSlowdown':args.receiver_slowdown})
        event(mode=mode,stage='warm',port=port,parent=parent)
        with (out/'resources.json').open('w') as resource:
            sampler=ssh(f'python3 {BASE}/group-samples.py {min(340,args.chunk_seconds*3+10)}',stdout=resource,stderr=subprocess.PIPE,text=True)
            chunks=[]
            for index,count in enumerate([34,33,33],1):
                if gui.poll() is not None:raise RuntimeError('GUI fixture expired')
                data=measure(f'chunk-{index}',{'seconds':args.chunk_seconds,'samples':count})
                chunks.append(data)
                event(mode=mode,stage='chunk',index=index,p95Ms=data['p95Ms'])
            # Resource trace includes 340s; preserve all data, aggregate actual
            # measurement interval separately (no averaging post-test idle time).
            sampler.wait(timeout=50)
            if sampler.returncode:raise RuntimeError(sampler.stderr.read())
        samples=[s for c in chunks for s in c['samples']]
        latency=sorted(s['latencyMs'] for s in samples)
        resources=json.loads((out/'resources.json').read_text())['samples']
        measured_seconds=sum(c['elapsedMs'] for c in chunks)/1000
        resource_end=next((s for s in resources if s['monotonic']-resources[0]['monotonic']>=measured_seconds),resources[-1])
        selected=[s for s in resources if s['monotonic']<=resource_end['monotonic']]
        cpu=(resource_end['usageUsec']-resources[0]['usageUsec'])/(resource_end['monotonic']-resources[0]['monotonic'])/10000
        deltas=[]
        for c in chunks:
            a,b=c['after']['stats'][0],c['before']['stats'][0]
            deltas.append({k:a.get(k,0)-b.get(k,0) for k in ['framesDecoded','framesDropped','freezeCount','pliCount','nackCount']})
        summary={'mode':mode,'receiverSlowdown':args.receiver_slowdown,'elapsedSeconds':measured_seconds,'inputSamples':len(samples),'p95Ms':latency[94],'maxMs':max(latency),'geometry':sorted(set((s['width'],s['height'])for s in samples)),'decodedFps':sum(d['framesDecoded']for d in deltas)/measured_seconds,'deltas':deltas,'cpuPercent':cpu,'peakRssMiB':max(s['rssSumKiB']for s in selected)/1024,'resourceSeconds':resource_end['monotonic']-resources[0]['monotonic'],'status':'measured, review against proposal; no automatic capability enable'}
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        event(**summary)
    finally:
        if target_id:
            subprocess.run(['node','scripts/bcap.mjs','close',target_id,'--session',args.session],cwd=args.bcap_root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
        if parent:
            try:checked(f'kill -INT {parent}')
            except subprocess.CalledProcessError:pass
        if forward:forward.terminate();forward.wait(timeout=10)
        if sampler and sampler.poll() is None:sampler.terminate()
        try:host.wait(timeout=12)
        except subprocess.TimeoutExpired:host.terminate();host.wait(timeout=5)
        if gui:
            try:gui.wait(timeout=10)
            except subprocess.TimeoutExpired:gui.terminate();gui.wait(timeout=5)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bcap-root',required=True)
    parser.add_argument('--session',required=True)
    parser.add_argument('--output-root',required=True)
    parser.add_argument('--measurement',choices=['reference','photon'],default='reference')
    parser.add_argument('--receiver-slowdown',type=int,choices=[1,4,8,16],default=1)
    parser.add_argument('--chunk-seconds',type=int,choices=range(1,101),default=100)
    parser.add_argument('--modes',nargs='+',choices=['static','scroll','drag'],default=['static','scroll','drag'])
    args=parser.parse_args()
    for mode in args.modes:run(args,mode)
