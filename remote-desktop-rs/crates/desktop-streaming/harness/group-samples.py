import json,time,os,sys
from pathlib import Path
group=Path('/sys/fs/cgroup/task-handoff-g1-reference')
samples=[]
seconds=min(340,max(2,int(sys.argv[1]) if len(sys.argv)>1 else 340))
for i in range(seconds):
 try:
  cpu=dict(line.split() for line in (group/'cpu.stat').read_text().splitlines())
  pids=[int(x)for x in (group/'cgroup.procs').read_text().split()]
  rss=0
  for pid in pids:
   try:
    status=Path(f'/proc/{pid}/status').read_text().splitlines()
    rss+=int(next(s for s in status if s.startswith('VmRSS:')).split()[1])
   except (FileNotFoundError,StopIteration):pass
  samples.append({'second':i,'monotonic':time.monotonic(),'usageUsec':int(cpu['usage_usec']),'throttledUsec':int(cpu['throttled_usec']),'memoryBytes':int((group/'memory.current').read_text()),'peakBytes':int((group/'memory.peak').read_text()),'rssSumKiB':rss,'processes':len(pids)})
 except FileNotFoundError:break
 time.sleep(1)
print(json.dumps({'cpuMax':'400000 100000','cpuset':'0-3','memoryMax':4294967296,'samples':samples}))
