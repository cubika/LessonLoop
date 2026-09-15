import ast
from pathlib import Path
from types import SimpleNamespace
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
