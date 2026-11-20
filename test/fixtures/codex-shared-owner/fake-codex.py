#!/usr/bin/env python3
"""Test-owned CLI: record launch, then expose a real Unix listener or fault."""
import errno
import json
import os
import socket
import subprocess
import sys
import time

root = os.environ['OWNER_PARITY_ROOT']
mode = os.environ.get('OWNER_PARITY_MODE', 'ready')
endpoint = sys.argv[sys.argv.index('--listen') + 1]
path = endpoint.removeprefix('unix://')
child = None
if mode in ('cancel', 'exit'):
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
if mode != 'exit':
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(path)
    if mode != 'cancel':
        listener.listen()
record = {'pid': os.getpid(), 'childPid': child.pid if child else None,
          'endpoint': endpoint, 'args': sys.argv[1:], 'cwd': os.getcwd(),
          'marker': os.environ['OWNER_PARITY_MARKER'], 'mode': mode}
with open(os.path.join(root, 'launches.jsonl'), 'a') as out:
    out.write(json.dumps(record) + '\n')
if mode == 'exit':
    print('owner-parity intentional exit 42', file=sys.stderr, flush=True)
    sys.exit(42)
if mode == 'cancel':
    while True:
        time.sleep(120)
while True:
    connection, _ = listener.accept()
    try:
        # Readiness only connects; the observation client explicitly asks for data.
        if connection.makefile('rb').readline() == b'greet\n':
            connection.sendall(os.environ['OWNER_PARITY_MARKER'].encode())
    except OSError as error:
        if error.errno not in (errno.EPIPE, errno.ECONNRESET, errno.ENOTCONN):
            raise
    finally:
        connection.close()
