"""Exercise the installed alpha via its loopback API; never export its credentials."""
import argparse
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import time
import urllib.request
import uuid

class Blob(ctypes.Structure):
    _fields_=[("size",wintypes.DWORD),("data",ctypes.POINTER(ctypes.c_byte))]

def secrets(root):
    raw=(root/"secrets.dpapi").read_bytes();buffer=ctypes.create_string_buffer(raw)
    incoming=Blob(len(raw),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_byte)));out=Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(incoming),None,None,None,None,0,ctypes.byref(out)):raise ctypes.WinError()
    try:return json.loads(ctypes.string_at(out.data,out.size))
    finally:ctypes.windll.kernel32.LocalFree(out.data)

p=argparse.ArgumentParser();p.add_argument("--data-root",type=Path,required=True);p.add_argument("--report",type=Path,required=True);args=p.parse_args()
root=args.data_root.resolve();record=json.loads((root/"installation.json").read_text(encoding="utf-8-sig"));secret=secrets(root)
base=f"http://127.0.0.1:{record['corePort']}"
def rpc(operation,value,channel="user",key=None):
    request=urllib.request.Request(base+"/v1/rpc",data=json.dumps({"operation":operation,"input":value}).encode(),headers={"Content-Type":"application/json","Authorization":"Bearer "+secret[channel+"Token"],"Idempotency-Key":key or str(uuid.uuid4())})
    with urllib.request.urlopen(request,timeout=70) as response:return json.load(response)["result"]
report={"classification":"installed_alpha_actual_provider","status":"failed","stages":[]}
try:
    scope=record["scopeId"]
    workspace=Path(record["allowedRoots"][0])/ ("alpha-fixture-"+str(uuid.uuid4()));workspace.mkdir()
    source=workspace/"schema.json";generated=workspace/"client.json"
    source.write_text(json.dumps({"fields":["id"]}));generated.write_text(json.dumps({"fields":["id","customerId"]}))
    generated.write_bytes(source.read_bytes());assert json.loads(generated.read_text())["fields"]==["id"]
    source.write_text(json.dumps({"fields":["id","customerId"]}));generated.write_bytes(source.read_bytes())
    assert json.loads(generated.read_text())["fields"]==["id","customerId"]
    task=rpc("startTask",{"scopeId":scope},"host")
    material={"scopeId":scope,"context":{"taskRef":task["taskRef"]},"segments":[
        {"role":"user","text":"Add customerId to the generated client and verify regeneration preserves it."},
        {"role":"tool","text":"Executed the isolated fixture: schema.json was copied to client.json. Editing client.json directly then regenerating lost customerId. Editing schema.json then regenerating produced fields [id, customerId]. Python equality assertions checked the actual files after both attempts."}]}
    receipt=rpc("submitSource",material,"host","alpha-synthetic-case-"+task["taskRef"])
    report["receipt"]=receipt
    deadline=time.monotonic()+900;last=None
    while time.monotonic()<deadline:
        job=rpc("getJob",{"id":receipt["jobId"]});state=job["stage"]+":"+job["status"]
        if state!=last:print(state,flush=True);report["stages"].append(state);last=state
        report["job"]=job
        if job["status"] in ["failed","canceled"]:raise RuntimeError("Learning job "+job["status"])
        if job["status"]=="completed" and job["receipt"]["replacement"]["status"]=="effective":break
        time.sleep(2)
    else:raise RuntimeError("Learning or publication deadline exceeded")
    playbooks=rpc("searchPlaybooks",{"query":"generated client regeneration"})
    report["playbooks"]=playbooks
    if not playbooks["results"]:raise RuntimeError("No usable playbook produced")
    playbook=playbooks["results"][0]["playbook"]
    fresh=rpc("startTask",{"scopeId":scope},"host")
    prepared=rpc("preparePlaybook",{"playbookId":playbook["id"],"revision":playbook["revision"],"taskRef":fresh["taskRef"]},"host")
    report["prepared"]=prepared
    if prepared["status"] != "guidance":raise RuntimeError("Method preparation unavailable")
    report["status"]="passed"
except Exception as error:report["error"]=str(error)
finally:
    args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,indent=2),encoding="utf-8")
print(json.dumps({"status":report["status"],"error":report.get("error")}));raise SystemExit(0 if report["status"]=="passed" else 1)
