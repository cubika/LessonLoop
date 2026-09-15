import ast
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import tempfile
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'distribution'))
source=Path('distribution/runtime.py').read_text()
tree=ast.parse(source)
parser_start=next(i for i,n in enumerate(tree.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='parser' for t in n.targets))
parser_end=next(i for i,n in enumerate(tree.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='args' for t in n.targets))
parser_ns={'argparse':__import__('argparse'),'Path':Path,'__file__':str(Path('distribution/runtime.py').resolve())}
exec(compile(ast.Module(body=tree.body[parser_start:parser_end],type_ignores=[]),'runtime-parser','exec'),parser_ns)
parse=parser_ns['parse_arguments']
forward=['method','list','--query','中文 query','--scope','project','--data-root','literal-cli-value','--','remaining']
parsed=parse(['cli','--runtime-root','program root','--data-root','data root','--',*forward])
assert parsed.arguments==forward and parsed.data_root=='data root' and parsed.scope=='personal'
parsed=parse(['agent','install','--data-root','data root','--allow-root','project root'])
assert parsed.arguments==['install'] and parsed.allow_root==['project root']
parsed=parse(['autostart','--data-root','data root','disable'])
assert parsed.arguments==['disable']
print('Runtime parser checks passed: CLI options and order survive the explicit boundary; manager actions still accept interspersed options.')
start=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='start_components')
stop=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='stop_components')
assert not any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and isinstance(n.func.value,ast.Name) and n.func.value.id=='sys' and n.func.attr=='exit' for n in ast.walk(start)), 'Internal lifecycle must return rather than exit during update recovery'
with tempfile.TemporaryDirectory(prefix='lessonloop-stop-test-') as directory:
 root=Path(directory);calls=[]
 def db(action):
  calls.append(action)
  if action=='status':raise RuntimeError('already stopped')
 ns={'root':root,'runtime':root/'runtime','record':{'installationId':'fixture'},'node':root/'node.exe','python':root/'python.exe','json':__import__('json'),'owned_process':lambda saved,exe:None,'call_db':db}
 exec(compile(ast.Module(body=[stop],type_ignores=[]),'runtime-stop','exec'),ns)
 assert ns['stop_components']()==0 and calls==[]
print('Runtime lifecycle checks passed: internal startup returns and stop is idempotent without a process record.')

# Recovery must be handled by a journal before requiring a previous successful upgrade.
assert source.index('if args.action=="rollback" and interrupted:') < source.index('if not record.get("previousRuntimeRoot")')
assert 'temporary.replace(journal)' in source
assert 'if db is not None:db.close()' in source
assert 'databaseRestored":False' in source

# System Python virtual environments launch a redirector plus the actual interpreter.
# Capture and stop only the child with the recorded path, time, and complete command.
import json
import time
owned=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='owned_process')
capture=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='process_record')
with tempfile.TemporaryDirectory(prefix='lessonloop-process-test-') as directory:
 root=Path(directory);venv=root/'.venv/Scripts/python.exe';base=root/'system/python.exe';script=root/'distribution/hindsight_server.py'
 command=[str(base),str(script)]
 child=SimpleNamespace(pid=102,exe=lambda:str(base),create_time=lambda:1000.25,cmdline=lambda:command)
 redirector=SimpleNamespace(pid=101,exe=lambda:str(venv),cmdline=lambda:[str(venv),str(script)],children=lambda:[child])
 fake=SimpleNamespace(Process=lambda pid:redirector if pid==101 else child)
 ns={'Path':Path,'time':time,'python':venv,'record':{'pythonBase':str(base)}}
 exec(compile(ast.Module(body=[owned,capture],type_ignores=[]),'runtime-ownership','exec'),ns)
 with patch.dict(sys.modules,{'psutil':fake}):
  saved=ns['process_record'](SimpleNamespace(pid=101,poll=lambda:None),str(base))
  assert saved['pid']==102 and saved['executable']==str(base)
  assert ns['owned_process'](saved,venv) is child
  assert ns['owned_process']({**saved,'startedAt':999},venv) is None
  assert ns['owned_process']({**saved,'command':[str(base),'other.py']},venv) is None
  child.exe=lambda:str(root/'other/python.exe')
  assert ns['owned_process'](saved,venv) is None
print('Runtime ownership checks passed: virtual-environment child requires matching executable, creation time, and full command.')

import os
if os.name=='nt' and sys.prefix!=sys.base_prefix:
 import subprocess
 import psutil
 ns={'Path':Path,'time':time,'python':Path(sys.executable),'record':{'pythonBase':sys._base_executable}}
 exec(compile(ast.Module(body=[owned,capture],type_ignores=[]),'runtime-owned-child','exec'),ns)
 child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],creationflags=subprocess.CREATE_NO_WINDOW)
 saved=None
 try:
  saved=ns['process_record'](child,sys._base_executable)
  assert saved['pid']!=child.pid, 'Windows venv redirector must record the real interpreter child'
  process=ns['owned_process'](saved,Path(sys.executable))
  assert process is not None
  process.terminate();process.wait(timeout=10)
  child.wait(timeout=10)
  assert ns['owned_process'](saved,Path(sys.executable)) is None
 finally:
  if saved:
   process=ns['owned_process'](saved,Path(sys.executable))
   if process:process.terminate();process.wait(timeout=10)
  if child.poll() is None:child.terminate();child.wait(timeout=10)
 print('Real virtual-environment process check passed: stopping the recorded engine child also exits its redirector.')
