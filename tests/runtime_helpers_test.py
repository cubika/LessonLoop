import ast
from pathlib import Path
from types import SimpleNamespace
import tempfile
source=Path('distribution/runtime.py').read_text()
tree=ast.parse(source)
start=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='start_components')
stop=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='stop_components')
assert not any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and isinstance(n.func.value,ast.Name) and n.func.value.id=='sys' and n.func.attr=='exit' for n in ast.walk(start)), 'Internal lifecycle must return rather than exit during update recovery'
with tempfile.TemporaryDirectory(prefix='lessonloop-stop-test-') as directory:
 root=Path(directory);calls=[]
 def db(action):
  calls.append(action)
  if action=='status':raise RuntimeError('already stopped')
 ns={'root':root,'record':{'installationId':'fixture'},'node':root/'node.exe','python':root/'python.exe','json':__import__('json'),'owned_process':lambda saved,exe:None,'call_db':db}
 exec(compile(ast.Module(body=[stop],type_ignores=[]),'runtime-stop','exec'),ns)
 assert ns['stop_components']()==0 and calls==['status']
print('Runtime lifecycle checks passed: internal startup returns and stop is idempotent without a process record.')

# Recovery must be handled by a journal before requiring a previous successful upgrade.
assert source.index('if args.action=="rollback" and interrupted:') < source.index('if not record.get("previousRuntimeRoot")')
assert 'temporary.replace(journal)' in source
assert 'if db is not None:db.close()' in source
assert 'databaseRestored":False' in source
