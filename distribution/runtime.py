"""Per-user runtime manager for a prebuilt LessonLoop component directory."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request
import uuid
import msvcrt
import shutil

class Blob(ctypes.Structure):
    _fields_=[("size",wintypes.DWORD),("data",ctypes.POINTER(ctypes.c_byte))]
def protect(value, decrypt=False):
    buffer=ctypes.create_string_buffer(value)
    incoming=Blob(len(value),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_byte)))
    outgoing=Blob()
    if decrypt:
        ok=ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(incoming),None,None,None,None,0,ctypes.byref(outgoing))
    else:
        ok=ctypes.windll.crypt32.CryptProtectData(ctypes.byref(incoming),"LessonLoop",None,None,None,0,ctypes.byref(outgoing))
    if not ok:raise ctypes.WinError()
    try:return ctypes.string_at(outgoing.data,outgoing.size)
    finally:ctypes.windll.kernel32.LocalFree(outgoing.data)

parser=argparse.ArgumentParser()
parser.add_argument("action",choices=["setup","start","stop","status","cli","agent-hook","mcp"])
parser.add_argument("--data-root",required=True)
parser.add_argument("--runtime-root",default=str(Path(__file__).resolve().parents[1]))
parser.add_argument("--scope",default="personal")
parser.add_argument("--base-port",type=int,default=19431)
parser.add_argument("--allow-root",action="append",default=[])
parser.add_argument("arguments",nargs="*")
args=parser.parse_args()
root=Path(args.data_root).resolve();runtime=Path(args.runtime_root).resolve()
root.mkdir(parents=True,exist_ok=True)
lock_file=(root/"manager.lock").open("a+b")
lock_file.seek(0);lock_file.write(b"0");lock_file.flush();lock_file.seek(0)
if args.action in ["setup","start","stop"]:
    try:msvcrt.locking(lock_file.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:raise SystemExit("Another runtime manager owns this DataRoot")
flags=subprocess.CREATE_NO_WINDOW
python=runtime/"python/python.exe";node=runtime/"node/node.exe"
record_path=root/"installation.json";secret_path=root/"secrets.dpapi"
def read_secrets():return json.loads(protect(secret_path.read_bytes(),True))
def call_db(action,secret=None):
    command=[str(python),str(runtime/"distribution/database.py"),action,"--runtime",str(runtime/"postgres"),"--data-root",str(root),"--port",str(record["databasePort"])]
    result=subprocess.run(command,input=json.dumps(secret) if secret else None,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=flags,timeout=80)
    if result.returncode:raise RuntimeError("Private database operation failed; inspect database-manager.log")
def start_database():
    try:call_db("status");return
    except RuntimeError:call_db("start")
def config(secret):return {"port":record["corePort"],"databaseUrl":f"postgresql://lessonloop:{secret['password']}@127.0.0.1:{record['databasePort']}/postgres","engineUrl":f"http://127.0.0.1:{record['enginePort']}","engineToken":secret["engineToken"],"credentials":[{"token":secret["userToken"],"principal":{"id":"owner","channel":"user","scopes":[record["scopeId"]]}},{"token":secret["hostToken"],"principal":{"id":"copilot-host","channel":"host","scopes":[record["scopeId"]]}},{"token":secret["agentToken"],"principal":{"id":"copilot-agent","channel":"agent","scopes":[record["scopeId"]]}}]}
def owned_process(saved,expected):
    try:
        import psutil
        process=psutil.Process(saved["pid"])
        return process if Path(process.exe()).resolve()==expected.resolve() and abs(process.create_time()-saved["startedAt"])<0.01 and process.cmdline()==saved["command"] else None
    except Exception:return None
def health(secret):
    request=urllib.request.Request(f"http://127.0.0.1:{record['corePort']}/v1/status",headers={"Authorization":"Bearer "+secret["userToken"]})
    with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)

if args.action=="setup":
    if record_path.exists():
        record=json.loads(record_path.read_text(encoding="utf-8"))
        if record.get("setupState")=="ready":raise SystemExit("Installation already configured; use start or status.")
        if record["dataRoot"]!=str(root) or record["runtimeRoot"]!=str(runtime):raise SystemExit("Installation ownership mismatch")
        secret=read_secrets()
    else:
        if secret_path.exists() or (root/"storage").exists():raise SystemExit("Unowned existing data requires recovery")
        record={"installationId":str(uuid.uuid4()),"runtimeRoot":str(runtime),"dataRoot":str(root),"scopeId":args.scope,"allowedRoots":[str(Path(p).resolve()) for p in args.allow_root],"databasePort":args.base_port+1,"corePort":args.base_port,"enginePort":args.base_port+2,"autostart":False,"setupState":"initializing"}
        secret={key:secrets.token_hex(32) for key in ["password","engineToken","userToken","hostToken","agentToken"]}
        secret_path.write_bytes(protect(json.dumps(secret).encode()))
        record_path.write_text(json.dumps(record,indent=2),encoding="utf-8")
    if not (root/"database-owner.json").exists():call_db("init",secret)
    start_database()
    import psycopg2
    with psycopg2.connect(config(secret)["databaseUrl"]) as db:
        with db.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
    initialize=subprocess.run([str(node),str(runtime/"dist/cli/main.js"),"initialize"],input=json.dumps(config(secret)).encode(),env={**os.environ,"LESSONLOOP_CONFIG_STDIN":"1"},creationflags=flags,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    if initialize.returncode:raise SystemExit("Product schema initialization failed")
    call_db("stop")
    record["setupState"]="ready";record_path.write_text(json.dumps(record,indent=2),encoding="utf-8")
    print(json.dumps({"status":"installed_needs_setup","reason":"Start the runtime, then configure learning and host scope. Copilot login is required for model calls."}))
    sys.exit(2)
record=json.loads(record_path.read_text(encoding="utf-8"))
if record["dataRoot"]!=str(root) or record["runtimeRoot"]!=str(runtime):raise SystemExit("Installation ownership mismatch")
secret=read_secrets();cfg=config(secret)
if args.action=="start":
    try:
        current=health(secret)
        print(json.dumps(current));sys.exit(0 if current["engine"]["status"]=="ready" else 2)
    except Exception:pass
    processes_path=root/"processes.json"
    if processes_path.exists():
        saved=json.loads(processes_path.read_text())
        if saved.get("installationId")!=record["installationId"]:raise SystemExit("Process ownership mismatch")
        existing=[owned_process(saved.get(name,{}),exe) for name,exe in [("core",node),("engine",python)]]
        if any(existing):print(json.dumps({"status":"starting_or_degraded","reason":"Existing owned components are still running; inspect status or stop before restarting."}));sys.exit(2)
    if record.get("setupState")!="ready":raise SystemExit("Setup is incomplete; rerun setup")
    start_database()
    import psycopg2
    with psycopg2.connect(cfg["databaseUrl"]) as db:
        with db.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
    env={**os.environ,"PYTHONUTF8":"1","PYTHONIOENCODING":"utf-8","PYTHONUNBUFFERED":"1","HINDSIGHT_API_DATABASE_URL":cfg["databaseUrl"],"HINDSIGHT_API_DATABASE_SCHEMA":"hindsight","HINDSIGHT_API_HOST":"127.0.0.1","HINDSIGHT_API_PORT":str(record["enginePort"]),"HINDSIGHT_API_LLM_PROVIDER":"github-copilot","HINDSIGHT_API_LLM_MODEL":"gpt-5.5","HINDSIGHT_API_EMBEDDINGS_PROVIDER":"onnx","HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH":str(runtime/"models/e5/onnx/model.onnx"),"HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH":str(runtime/"models/e5"),"HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS":"384","HINDSIGHT_API_RERANKER_PROVIDER":"rrf","HINDSIGHT_API_TENANT_EXTENSION":"hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension","HINDSIGHT_API_TENANT_API_KEY":secret["engineToken"],"HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1","COPILOT_SKIP_CLI_DOWNLOAD":"1","HINDSIGHT_API_LOG_LEVEL":"WARNING","HINDSIGHT_API_ACCESS_LOG":"false"}
    copilot=shutil.which("copilot.exe")
    if copilot:env["COPILOT_CLI_PATH"]=str(Path(copilot).resolve())
    with (root/"engine.log").open("ab") as log:
        engine=subprocess.Popen([str(python),str(runtime/"distribution/hindsight_server.py")],env=env,stdout=log,stderr=log,creationflags=flags|subprocess.DETACHED_PROCESS,cwd=root)
    with (root/"core.log").open("ab") as log:
        core_args=[str(node),str(runtime/"dist/cli/main.js"),"serve"]
        core=subprocess.Popen(core_args,env={**os.environ,"LESSONLOOP_CONFIG_STDIN":"1"},stdin=subprocess.PIPE,stdout=log,stderr=log,creationflags=flags|subprocess.DETACHED_PROCESS,cwd=root)
        core.stdin.write(json.dumps(cfg).encode());core.stdin.close()
    import psutil
    def process_record(child):
        p=psutil.Process(child.pid);return {"pid":child.pid,"startedAt":p.create_time(),"command":p.cmdline()}
    (root/"processes.json").write_text(json.dumps({"installationId":record["installationId"],"engine":process_record(engine),"core":process_record(core)}),encoding="utf-8")
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        try:
            state=health(secret)
            if state["engine"]["status"]=="ready":
                print(json.dumps(state));sys.exit(0)
        except Exception:pass
        time.sleep(1)
    print(json.dumps({"status":"starting","reason":"Cold initialization exceeded 120 seconds; components remain owned and may become ready. Use status to check."}));sys.exit(2)
elif args.action=="status":
    try:
        state=health(secret);print(json.dumps(state));sys.exit(0 if state["engine"]["status"]=="ready" else 2)
    except Exception:print(json.dumps({"status":"unavailable"}));sys.exit(2)
elif args.action=="stop":
    processes=json.loads((root/"processes.json").read_text())
    if processes["installationId"]!=record["installationId"]:raise SystemExit("Process ownership mismatch")
    for name,exe in [("core",node),("engine",python)]:
        process=owned_process(processes[name],exe)
        if process:process.terminate();process.wait(timeout=30)
    call_db("stop");print(json.dumps({"status":"stopped"}))
else:
    env={**os.environ};command=[str(node)]
    if args.action=="cli":env["LESSONLOOP_CONFIG_STDIN"]="1";command+=[str(runtime/"dist/cli/main.js"),*args.arguments];payload=json.dumps(cfg).encode()
    elif args.action=="mcp":env["LESSONLOOP_AGENT_CONFIG_JSON"]=json.dumps({"baseUrl":f"http://127.0.0.1:{record['corePort']}","token":secret["agentToken"]});command+=[str(runtime/"dist/adapters/copilot/mcp.js")];payload=None
    else:env["LESSONLOOP_HOST_CONFIG_JSON"]=json.dumps({"baseUrl":f"http://127.0.0.1:{record['corePort']}","token":secret["hostToken"],"scopeId":record["scopeId"],"allowedRoots":record["allowedRoots"],"stateRoot":str(root/"host-state")});command+=[str(runtime/"dist/adapters/copilot/hook.js"),*args.arguments];payload=sys.stdin.buffer.read()
    result=subprocess.run(command,input=payload,env=env,creationflags=flags)
    sys.exit(result.returncode)
