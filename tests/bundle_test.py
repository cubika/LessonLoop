import importlib.util
import json
from pathlib import Path
import tempfile
import hashlib
import subprocess
import sys
spec=importlib.util.spec_from_file_location("bundle",Path(__file__).parents[1]/"distribution/bundle.py");bundle=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle)
with tempfile.TemporaryDirectory(prefix="lessonloop-bundle-") as directory:
 root=Path(directory)/"source";root.mkdir()
 names=["python/python.exe","node/node.exe","distribution/runtime.py","dist/cli/main.js","config/components.json","distribution/launcher.ps1","distribution/check_runtime.py"]
 files=[]
 for name in names:
  path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b"synthetic bundle test")
  files.append({"path":name,"size":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
 manifest={"version":"test","platform":"win32-x64","releaseReady":False,"files":files,"compatibility":{"productSchema":1,"protocol":1,"activationCheck":1,"hindsight":"0.9.2","postgresql":"18.1","pgvector":"0.8.5"}}
 def save(value): (root/"manifest.json").write_text(json.dumps(value),encoding="utf-8")
 def reject(action):
  try:action();raise AssertionError("unsafe bundle accepted")
  except ValueError:pass
 save(manifest);reject(lambda:bundle.verify(root));bundle.verify(root,True)
 save({**manifest,"version":"0.1.0-alpha.1","channel":"alpha","alphaReady":True});bundle.verify(root)
 save({**manifest,"version":"0.1.0","channel":"alpha","alphaReady":True});reject(lambda:bundle.verify(root))
 save(manifest)
 original_copy=bundle.shutil.copyfile
 def fail_copy(*args,**kwargs):raise OSError("simulated copy interruption")
 bundle.shutil.copyfile=fail_copy
 try:bundle.stage(root,Path(directory)/"install",True);raise AssertionError("copy failure expected")
 except OSError:pass
 finally:bundle.shutil.copyfile=original_copy
 destination,_,digest=bundle.stage(root,Path(directory)/"install",True);assert destination.name==digest;bundle.verify(destination,True)
 bundle.compatible(manifest,manifest)
 # The upgrade health command starts no server and performs only read-only SQL.
 check_script=(Path(__file__).parents[1]/"distribution/check_runtime.py").read_text()
 assert 'default_transaction_read_only=on' in check_script
 assert 'MemoryEngine(' not in check_script and 'create_app(' not in check_script

 changed={**manifest,"compatibility":{**manifest["compatibility"],"productSchema":2}};reject(lambda:bundle.compatible(manifest,changed))
 save({**manifest,"files":[*files,files[0]]});reject(lambda:bundle.verify(root,True))
 for path in ["../outside", "python/python.exe:stream", "C:/outside", "python/CON.", "python/NUL.txt", "python/a ", "python/../node/node.exe"]:
  save({**manifest,"files":[{**files[0],"path":path},*files[1:]]});reject(lambda:bundle.verify(root,True))
 save(manifest);(root/names[0]).write_bytes(b"changed");reject(lambda:bundle.verify(root,True))
print("Bundle validation passed: accepted bytes, release gate, staging, compatibility, duplicate/escape/ADS paths and tampering.")
