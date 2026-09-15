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

def windows_path(path):
    value=str(path)
    buffer=ctypes.create_unicode_buffer(32768)
    length=ctypes.windll.kernel32.GetShortPathNameW(value,buffer,len(buffer))
    return buffer.value if length else value

parser=argparse.ArgumentParser()
parser.add_argument("action",choices=["setup","start","stop","status","doctor","update","rollback","cli","agent-hook","mcp","autostart","uninstall","data","configure","agent","ui"])
parser.add_argument("--data-root",required=True)
parser.add_argument("--runtime-root",default=str(Path(__file__).resolve().parents[1]))
parser.add_argument("--scope",default="personal")
parser.add_argument("--base-port",type=int,default=19431)
parser.add_argument("--allow-root",action="append",default=[])
parser.add_argument("--wait-seconds",type=int,default=120)
parser.add_argument("--bundle")
parser.add_argument("--allow-development-build",action="store_true")
parser.add_argument("--confirm")
parser.add_argument("--copilot-home")
learning=parser.add_mutually_exclusive_group()
learning.add_argument("--enable-learning",action="store_true")
learning.add_argument("--disable-learning",action="store_true")
parser.add_argument("arguments",nargs="*")
def parse_arguments(argv):
    if "--" in argv:
        boundary=argv.index("--")
        parsed=parser.parse_intermixed_args(argv[:boundary])
        if parsed.action=="cli":
            parsed.arguments.extend(argv[boundary+1:])
            return parsed
    return parser.parse_intermixed_args(argv)

args=parse_arguments(sys.argv[1:])
from bundle import unlinked
root=unlinked(args.data_root);runtime=unlinked(args.runtime_root)
root.mkdir(parents=True,exist_ok=True)
program_hint=runtime
if (root/"installation.json").exists():program_hint=unlinked(json.loads((root/"installation.json").read_text(encoding="utf-8-sig")).get("programRoot",runtime))
program_lock=(program_hint/"installation.lock").open("a+b")
program_lock.seek(0);program_lock.write(b"0");program_lock.flush();program_lock.seek(0)
if args.action in ["setup","start","stop","update","rollback","autostart","uninstall","data","configure","agent","ui"]:
    try:msvcrt.locking(program_lock.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:raise SystemExit("Another manager owns this InstallRoot")
lock_file=(root/"manager.lock").open("a+b")
lock_file.seek(0);lock_file.write(b"0");lock_file.flush();lock_file.seek(0)
if args.action in ["setup","start","stop","update","rollback","autostart","uninstall","data","configure","agent","ui"]:
    try:msvcrt.locking(lock_file.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:raise SystemExit("Another runtime manager owns this DataRoot")
flags=subprocess.CREATE_NO_WINDOW
python=runtime/"python/python.exe";node=runtime/"node/node.exe"
record_path=root/"installation.json";secret_path=root/"secrets.dpapi"
def read_secrets():return json.loads(protect(secret_path.read_bytes(),True))
def call_db(action,secret=None):
    command=[str(python),str(runtime/"distribution/database.py"),action,"--runtime",str(Path(record.get("databaseRuntimeRoot",runtime/"postgres"))),"--data-root",str(root),"--port",str(record["databasePort"])]
    result=subprocess.run(command,input=json.dumps(secret) if secret else None,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=flags,timeout=80)
    if result.returncode:raise RuntimeError("Private database operation failed; inspect database-manager.log")
def start_database():
    try:call_db("status");return False
    except RuntimeError:call_db("start");return True
def config(secret):return {"port":record["corePort"],"databaseUrl":f"postgresql://lessonloop:{secret['password']}@127.0.0.1:{record['databasePort']}/postgres","engineUrl":f"http://127.0.0.1:{record['enginePort']}","engineToken":secret["engineToken"],"credentials":[{"token":secret["userToken"],"principal":{"id":"owner","channel":"user","scopes":[record["scopeId"]]}},{"token":secret["hostToken"],"principal":{"id":"copilot-host","channel":"host","scopes":[record["scopeId"]]}},{"token":secret["agentToken"],"principal":{"id":"copilot-agent","channel":"agent","taskOwnerId":"copilot-host","scopes":[record["scopeId"]]}}]}
def owned_process(saved,expected):
    try:
        import psutil
        process=psutil.Process(saved["pid"])
        return process if Path(process.exe()).resolve()==expected.resolve() and abs(process.create_time()-saved["startedAt"])<0.01 and process.cmdline()==saved["command"] else None
    except Exception:return None
def health(secret):
    request=urllib.request.Request(f"http://127.0.0.1:{record['corePort']}/v1/status",headers={"Authorization":"Bearer "+secret["userToken"]})
    with urllib.request.urlopen(request,timeout=5) as response:state=json.load(response)
    if state.get("engine",{}).get("status")=="ready":
        import psycopg2
        with psycopg2.connect(config(secret)["databaseUrl"],options="-c default_transaction_read_only=on",connect_timeout=5) as db:
            with db.cursor() as cur:
                cur.execute("SELECT to_regclass('hindsight.banks'),to_regclass('hindsight.async_operations'),to_regclass('lessonloop.objects')")
                if any(value is None for value in cur.fetchone()):state["engine"]={"status":"initializing","reason":"database_schema_not_ready"}
    return state

if args.action=="setup":
    if record_path.exists():
        record=json.loads(record_path.read_text(encoding="utf-8-sig"))
        if record.get("setupState")=="ready":raise SystemExit("Installation already configured; use start or status.")
        if record["dataRoot"]!=str(root) or record["runtimeRoot"]!=str(runtime):raise SystemExit("Installation ownership mismatch")
        if record.get("setupState")=="purged":
            record["setupState"]="initializing"
            record["scopeId"]=args.scope;record["allowedRoots"]=[str(Path(path).resolve()) for path in args.allow_root]
            secret={key:secrets.token_hex(32) for key in ["password","engineToken","userToken","hostToken","agentToken"]}
            secret_path.write_bytes(protect(json.dumps(secret).encode()))
            record_path.write_text(json.dumps(record,indent=2),encoding="utf-8")
        elif record.get("setupState")=="removal_pending":raise SystemExit("Removal is incomplete; retry the saved cleanup command")
        else:secret=read_secrets()
    else:
        if secret_path.exists() or (root/"storage").exists():raise SystemExit("Unowned existing data requires recovery")
        record={"installationId":str(uuid.uuid4()),"programRoot":str(runtime),"runtimeRoot":str(runtime),"dataRoot":str(root),"scopeId":args.scope,"allowedRoots":[str(Path(p).resolve()) for p in args.allow_root],"databasePort":args.base_port+1,"corePort":args.base_port,"enginePort":args.base_port+2,"autostart":False,"setupState":"initializing"}
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
record=json.loads(record_path.read_text(encoding="utf-8-sig"))
recovery_runtime=runtime
if record["dataRoot"]!=str(root):raise SystemExit("Installation ownership mismatch")
if record.get("setupState")=="removal_pending":raise SystemExit("Removal is incomplete; retry the saved cleanup command")
if record["runtimeRoot"]!=str(runtime):
    recovery_journal=json.loads((root/"update-state.json").read_text(encoding="utf-8"))
    if args.action!="rollback" or recovery_journal.get("installationId")!=record["installationId"] or recovery_journal.get("from")!=str(runtime) or recovery_journal.get("phase") not in ["prepared","backed_up","switching","checking"]:raise SystemExit("Installation ownership mismatch")
    runtime=unlinked(record["runtimeRoot"]);python=runtime/"python/python.exe";node=runtime/"node/node.exe"
update_record=root/"update-state.json"
if update_record.exists():
    prior_update=json.loads(update_record.read_text(encoding="utf-8"))
    if prior_update.get("installationId")!=record["installationId"]:raise SystemExit("Update ownership mismatch")
    if prior_update.get("phase") in ["prepared","backed_up","switching","checking"] and args.action not in ["rollback","status","doctor","stop"]:raise SystemExit("Interrupted update requires rollback before normal use")


if args.action=="autostart":
    from lifecycle import autostart,save_json
    action=args.arguments[0] if len(args.arguments)==1 else "status"
    if action not in ["enable","disable","status"] or len(args.arguments)>1:raise SystemExit("Use autostart enable, disable, or status")
    state=autostart(action,record,runtime,root)
    if action!="status":record["autostart"]=action=="enable";save_json(record_path,record)
    print(json.dumps(state));sys.exit(0 if state["autostart"]!="conflict" else 2)

secret=read_secrets() if secret_path.exists() and args.action not in ["uninstall","data","stop"] else None
if secret is None and args.action not in ["uninstall","data","stop"]:raise SystemExit("Data has been purged; run setup before starting")
cfg=config(secret) if secret else None
def start_components():
    global record,runtime,python,node,cfg
    processes_path=root/"processes.json"
    saved={"installationId":record["installationId"]}
    if processes_path.exists():
        saved=json.loads(processes_path.read_text())
        if saved.get("installationId")!=record["installationId"]:raise SystemExit("Process ownership mismatch")
    existing={name:owned_process(saved.get(name,{}),exe) for name,exe in [("core",node),("engine",python)]}
    if all(existing.values()):
        try:
            current=health(secret)
            if current["engine"]["status"]=="ready":return 0
        except Exception:pass
    if record.get("setupState")!="ready":raise SystemExit("Setup is incomplete; rerun setup")
    database_restarted=start_database()
    if database_restarted:
        # The core's singleton connection cannot survive database termination.
        for name in ["core","engine"]:
            if existing[name]:existing[name].terminate();existing[name].wait(timeout=30);existing[name]=None
    elif existing["core"]:
        try:health(secret)
        except Exception:
            existing["core"].terminate();existing["core"].wait(timeout=30);existing["core"]=None
    import psycopg2
    with psycopg2.connect(cfg["databaseUrl"]) as db:
        with db.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
    env={**os.environ,"PYTHONUTF8":"1","PYTHONIOENCODING":"utf-8","PYTHONUNBUFFERED":"1","HINDSIGHT_API_DATABASE_URL":cfg["databaseUrl"],"HINDSIGHT_API_DATABASE_SCHEMA":"hindsight","HINDSIGHT_API_HOST":"127.0.0.1","HINDSIGHT_API_PORT":str(record["enginePort"]),"HINDSIGHT_API_LLM_PROVIDER":"github-copilot","HINDSIGHT_API_LLM_MODEL":"gpt-5.5","HINDSIGHT_API_EMBEDDINGS_PROVIDER":"onnx","HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH":str(runtime/"models/e5/onnx/model.onnx"),"HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH":str(runtime/"models/e5"),"HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS":"384","HINDSIGHT_API_RERANKER_PROVIDER":"rrf","HINDSIGHT_API_TENANT_EXTENSION":"hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension","HINDSIGHT_API_TENANT_API_KEY":secret["engineToken"],"HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1","COPILOT_SKIP_CLI_DOWNLOAD":"1","HINDSIGHT_API_LOG_LEVEL":"WARNING","HINDSIGHT_API_ACCESS_LOG":"false"}
    from reranker import configuration as reranker_configuration,environment as reranker_environment
    reranker=reranker_configuration(runtime)
    env={key:value for key,value in env.items() if not key.startswith("HINDSIGHT_API_RERANKER_")}
    env.update(reranker_environment(reranker))
    if reranker["status"]=="ready":env["PYTHONPATH"]=os.pathsep.join(filter(None,[reranker["pythonDirectory"],env.get("PYTHONPATH")]))
    copilot=shutil.which("copilot.exe")
    env.update(HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP="true",LITELLM_LOCAL_MODEL_COST_MAP="true",HINDSIGHT_API_LLM_TRACE_ENABLED="false",HINDSIGHT_API_AUDIT_LOG_ENABLED="false",HINDSIGHT_API_OPERATION_RETENTION_DAYS="30")
    env.update(HINDSIGHT_API_HTTP_EXTENSION="hindsight_product:LessonLoopProduct",HINDSIGHT_API_HTTP_PRODUCT_KEY=secret["engineToken"])
    if copilot:env["COPILOT_CLI_PATH"]=str(Path(copilot).resolve())
    import psutil
    def process_record(child):
        process=psutil.Process(child.pid)
        return {"pid":child.pid,"startedAt":process.create_time(),"command":process.cmdline()}
    def save_processes():
        temporary=processes_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(saved),encoding="utf-8")
        temporary.replace(processes_path)
    if not existing["engine"]:
        with (root/"engine.log").open("ab") as log:
            log.write((json.dumps({"reranker":reranker})+"\n").encode());log.flush()
            engine=subprocess.Popen([str(python),str(runtime/"distribution/hindsight_server.py")],env=env,stdout=log,stderr=log,creationflags=flags|subprocess.DETACHED_PROCESS,cwd=root)
        saved["engine"]=process_record(engine);saved["reranker"]=reranker;save_processes()
    if not existing["core"]:
        with (root/"core.log").open("ab") as log:
            core_args=[str(node),str(runtime/"dist/cli/main.js"),"serve"]
            core=subprocess.Popen(core_args,env={**os.environ,"LESSONLOOP_CONFIG_STDIN":"1"},stdin=subprocess.PIPE,stdout=log,stderr=log,creationflags=flags|subprocess.DETACHED_PROCESS,cwd=root)
            saved["core"]=process_record(core);save_processes()
            core.stdin.write(json.dumps(cfg).encode());core.stdin.close()
    deadline=time.monotonic()+max(0,min(args.wait_seconds,600))
    while time.monotonic()<deadline:
        try:
            state=health(secret)
            if state["engine"]["status"]=="ready":
                return 0
        except Exception:pass
        time.sleep(1)
    return 2

def stop_components():
    from lifecycle import owned_database
    processes=json.loads((root/"processes.json").read_text()) if (root/"processes.json").exists() else {"installationId":record["installationId"]}
    if processes["installationId"]!=record["installationId"]:raise SystemExit("Process ownership mismatch")
    for name,exe in [("core",node),("engine",python)]:
        saved=processes.get(name,{})
        process=owned_process(saved,exe)
        if process:process.terminate();process.wait(timeout=30)
        elif saved.get("pid"):
            import psutil
            if psutil.pid_exists(saved["pid"]):raise RuntimeError("Recorded process is no longer owned; manual reconciliation required")
    database=owned_database(record,runtime,root)
    if database:
        call_db("stop")
        if owned_database(record,runtime,root):raise RuntimeError("Owned database did not stop")
    return 0
if args.action in ["uninstall","data"]:
    from lifecycle import removal_plan,autostart,ensure_adapters_closed,save_json
    if args.action=="data" and args.arguments!=["purge"]:raise SystemExit("Use data purge --confirm <installationId>")
    action="purge" if args.action=="data" else "uninstall"
    plan=removal_plan(action,record,runtime,root,args.confirm)
    plan["previousSetupState"]=record.get("setupState","ready")
    save_json(root/"removal-plan.json",plan)
    record.update(setupState="removal_pending",removalAction=action)
    save_json(record_path,record)
    try:
        ensure_adapters_closed(plan["programRoot"])
        autostart("disable",record,runtime,root)
        record["autostart"]=False
        stop_components()
        from integration import agent_action
        agent_action("remove",record,runtime,root,copilot_home=args.copilot_home)
        save_json(record_path,record)
    except Exception:
        record["setupState"]=plan["previousSetupState"];record.pop("removalAction",None)
        save_json(record_path,record)
        (root/"removal-plan.json").unlink(missing_ok=True)
        raise
    print(json.dumps({"status":"cleanup_required","plan":str(root/"removal-plan.json"),"dataRoot":str(root)}));sys.exit(0)
elif args.action=="start":
    code=start_components();print(json.dumps(health(secret) if code==0 else {"status":"starting"}));sys.exit(code)
elif args.action=="agent":
    from integration import agent_action,configure
    action=args.arguments[0] if len(args.arguments)==1 else "status"
    if action not in ["install","remove","status"] or len(args.arguments)>1:raise SystemExit("Use agent install, remove, or status")
    if args.allow_root:
        if action!="install":raise SystemExit("--allow-root is only valid for agent install")
        configure(record,runtime,root,cfg,args.allow_root)
    state=agent_action(action,record,runtime,root,copilot_home=args.copilot_home)
    print(json.dumps(state));sys.exit(2 if state.get("status") in ["needs_configuration","conflict"] else 0)
elif args.action=="configure":
    from integration import configure
    code=start_components()
    if code:print(json.dumps({"status":"starting"}));sys.exit(code)
    enabled=True if args.enable_learning else False if args.disable_learning else None
    print(json.dumps(configure(record,runtime,root,cfg,args.allow_root,enabled=enabled)))
elif args.action=="ui":
    from integration import open_ui
    code=start_components()
    if code:print(json.dumps({"status":"starting"}));sys.exit(code)
    print(json.dumps(open_ui(cfg)))
elif args.action=="doctor":
    processes=json.loads((root/"processes.json").read_text()) if (root/"processes.json").exists() else {}
    state={"installation":"owned","runtimeFiles":all(path.exists() for path in [python,node,runtime/"postgres/bin/postgres.exe",runtime/"models/e5/onnx/model.onnx"]),"copilotCli":"available" if shutil.which("copilot.exe") else "missing","modelAuthentication":"not_verified","hostIntegration":"needs_configuration"}
    from reranker import configuration as reranker_configuration
    state["rerankerPrepared"]=reranker_configuration(runtime)
    state["rerankerProcess"]=processes.get("reranker",{"provider":"unknown","status":"not_recorded"}) if owned_process(processes.get("engine",{}),python) else {"status":"not_running"}
    for name,exe in [("core",node),("engine",python)]:state[name+"Process"]="owned_running" if owned_process(processes.get(name,{}),exe) else "not_running"
    try:state["health"]=health(secret)
    except Exception:state["health"]={"core":"unavailable"}
    from integration import diagnostics
    state.update(diagnostics(record,runtime,root,cfg))
    from lifecycle import autostart
    state.update(autostart("status",record,runtime,root))
    state["installationId"]=record["installationId"];state["dataRoot"]=str(root)
    ready=state["runtimeFiles"] and state.get("health",{}).get("engine",{}).get("status")=="ready" and state["modelAuthentication"].get("status")=="authenticated" and state["hostIntegration"].get("status")=="registered" and state["autostart"]!="conflict"
    state["status"]="ready" if ready else "installed_needs_setup"
    print(json.dumps(state));sys.exit(0 if ready else 2)
elif args.action=="status":
    try:
        state=health(secret);print(json.dumps(state));sys.exit(0 if state["engine"]["status"]=="ready" else 2)
    except Exception:print(json.dumps({"status":"unavailable"}));sys.exit(2)
elif args.action=="stop":
    stop_components();print(json.dumps({"status":"stopped"}))

elif args.action in ["update","rollback"]:
    from bundle import verify,compatible,stage,unlinked,file_hash
    import psycopg2
    program=unlinked(record.get("programRoot",runtime))
    previous_record=dict(record);previous_runtime=runtime
    interrupted=None
    journal=root/"update-state.json"
    if journal.exists():
        candidate=json.loads(journal.read_text(encoding="utf-8"))
        if candidate.get("installationId")==record["installationId"] and candidate.get("phase") in ["prepared","backed_up","switching","checking"]:interrupted=candidate
    if args.action=="rollback" and interrupted:
        restored=interrupted.get("previousRecord")
        if not restored or restored.get("installationId")!=record["installationId"]:raise SystemExit("Missing owned recovery record")
        target=unlinked(restored["runtimeRoot"])
        if not target.is_relative_to(program):raise SystemExit("Recovery runtime outside installation")
        if restored.get("dataRoot")!=str(root):raise SystemExit("Recovery data root mismatch")
        verify(target,args.allow_development_build)
        # Recovery runs using the old verified Python, even when the target cannot start.
        processes=json.loads((root/"processes.json").read_text()) if (root/"processes.json").exists() else {"installationId":record["installationId"]}
        if processes["installationId"]!=record["installationId"]:raise SystemExit("Process ownership mismatch")
        for name,exe in [("core",node),("engine",python)]:
            process=owned_process(processes.get(name,{}),exe)
            if process:process.terminate();process.wait(timeout=30)
        database_runtime=Path(record.get("databaseRuntimeRoot",target/"postgres"))
        stopped=subprocess.run([str(recovery_runtime/"python/python.exe"),str(recovery_runtime/"distribution/database.py"),"stop","--runtime",str(database_runtime),"--data-root",str(root),"--port",str(record["databasePort"])],capture_output=True,creationflags=flags,timeout=80)
        if stopped.returncode:
            status=subprocess.run([str(recovery_runtime/"python/python.exe"),str(recovery_runtime/"distribution/database.py"),"status","--runtime",str(database_runtime),"--data-root",str(root)],capture_output=True,creationflags=flags,timeout=80)
            if status.returncode==0:raise SystemExit("Recovery could not stop the owned database")
        record=restored;runtime=target;python=runtime/"python/python.exe";node=runtime/"node/node.exe";cfg=config(secret)
        temporary=record_path.with_suffix(".tmp");temporary.write_text(json.dumps(record),encoding="utf-8");temporary.replace(record_path)
        active=program/"active.json";temporary=active.with_suffix(".tmp");temporary.write_text(json.dumps({"installationId":record["installationId"],"runtimeRoot":str(runtime),"dataRoot":str(root)}),encoding="utf-8");temporary.replace(active)
        interrupted["phase"]="rolled_back_without_restoring_database"
        temporary=journal.with_suffix(".tmp");temporary.write_text(json.dumps(interrupted),encoding="utf-8");temporary.replace(journal)
        code=start_components();print(json.dumps({"status":"recovered" if code==0 else "starting","database":"current_data_preserved"}));sys.exit(code)
    if root==program or root.is_relative_to(program) or program.is_relative_to(root):raise SystemExit("Program and data roots cannot contain each other")
    current_manifest,current_digest=verify(runtime,args.allow_development_build)
    if args.action=="update":
        if not args.bundle:raise SystemExit("--bundle is required")
        incoming_manifest,incoming_digest=verify(args.bundle,args.allow_development_build)
        compatible(current_manifest,incoming_manifest)
        print(json.dumps({"phase":"staging_verified_bundle"}),flush=True)
        target,incoming_manifest,target_digest=stage(args.bundle,program,args.allow_development_build,(incoming_manifest,incoming_digest))
    else:
        if not record.get("previousRuntimeRoot"):raise SystemExit("No prior compatible version")
        target=unlinked(record["previousRuntimeRoot"])
        incoming_manifest,target_digest=verify(target,args.allow_development_build)
        compatible(current_manifest,incoming_manifest)
    if not target.is_relative_to(program) or target==root or target.is_relative_to(root):raise SystemExit("Version path ownership mismatch")
    if args.action=="update" and not (program/"active.json").exists():
        shutil.copyfile(previous_runtime/"distribution/launcher.ps1",program/"lessonloop.ps1")
        (program/"active.json").write_text(json.dumps({"installationId":record["installationId"],"runtimeRoot":str(previous_runtime),"dataRoot":str(root),"manifestDigest":current_digest}),encoding="utf-8")
    if target==runtime:print(json.dumps({"status":"unchanged"}));sys.exit(0)
    update_path=root/"update-state.json"
    state={"installationId":record["installationId"],"from":str(runtime),"to":str(target),"phase":"prepared","databaseRestored":False,"previousRecord":previous_record}
    def save_json(path,value):
        tmp=path.with_suffix(path.suffix+".tmp");tmp.write_text(json.dumps(value,indent=2),encoding="utf-8");tmp.replace(path)
    save_json(update_path,state)
    switched=False
    stop_attempted=False
    db=None
    active_path=program/"active.json"
    previous_active=json.loads(active_path.read_text(encoding="utf-8")) if active_path.exists() else None
    try:
        stop_attempted=True
        print(json.dumps({"phase":"checking_quiescence"}),flush=True)
        stop_components();start_database()
        with psycopg2.connect(cfg["databaseUrl"]) as db:
            with db.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(761259483)")
                if not cur.fetchone()[0]:raise RuntimeError("Core still owns the database")
                cur.execute("SELECT count(*) FROM lessonloop.objects WHERE kind IN ('job','revision_review') AND value->>'status' IN ('queued','running','uncertain')")
                if cur.fetchone()[0]:raise RuntimeError("Finish or cancel accepted work before updating")
                cur.execute("SELECT count(*) FROM lessonloop.objects WHERE (kind='source_cleanup' AND value->>'status'='pending') OR (kind='publication_group' AND value->>'state'='pending')")
                if cur.fetchone()[0]:raise RuntimeError("Finish source cleanup and publication before updating")
                cur.execute("SELECT to_regclass('hindsight.async_operations')")
                if cur.fetchone()[0]:
                    cur.execute("SELECT count(*) FROM hindsight.async_operations WHERE status IN ('pending','processing')")
                    if cur.fetchone()[0]:raise RuntimeError("Native operations are not terminal; update refused")
                cur.execute("SELECT version FROM lessonloop.schema_version")
                if cur.fetchall()!=[(incoming_manifest["compatibility"]["productSchema"],)]:raise RuntimeError("Product schema is incompatible")
                print(json.dumps({"phase":"database_backup"}),flush=True)
                backup=unlinked(root/"backups"/(str(uuid.uuid4())+".dump"));backup.parent.mkdir(parents=True,exist_ok=True)
                pg_runtime=Path(record.get("databaseRuntimeRoot",runtime/"postgres"))
                backup_argument=str(Path(windows_path(backup.parent))/backup.name)
                command=[windows_path(pg_runtime/"bin/pg_dump.exe"),"-h","127.0.0.1","-p",str(record["databasePort"]),"-U","lessonloop","-d","postgres","-Fc","-f",backup_argument]
                dumped=subprocess.run(command,env={**os.environ,"PGPASSWORD":secret["password"]},capture_output=True,creationflags=flags,timeout=300)
                if dumped.returncode:
                    (root/"update-backup-error.log").write_bytes(dumped.stderr)
                    raise RuntimeError("Consistent database backup failed; see update-backup-error.log")
                backup_config=backup.with_suffix(".config.json")
                backup_config.write_text(json.dumps(record,indent=2),encoding="utf-8")
                shutil.copyfile(secret_path,backup.with_suffix(".secrets.dpapi"))
                state.update(phase="backed_up",backup=str(backup),backupSha256=file_hash(backup));save_json(update_path,state)
        db.close()
        call_db("stop")
        record={**record,"programRoot":str(program),"runtimeRoot":str(target),"previousRuntimeRoot":str(previous_runtime),"databaseRuntimeRoot":str(previous_record.get("databaseRuntimeRoot",previous_runtime/"postgres")),"manifestDigest":target_digest}
        state["previousRecord"]=previous_record;state["phase"]="switching";save_json(update_path,state)
        save_json(record_path,record);runtime=target;python=runtime/"python/python.exe";node=runtime/"node/node.exe";cfg=config(secret);switched=True
        state["phase"]="checking";save_json(update_path,state)
        print(json.dumps({"phase":"read_only_compatibility_check"}),flush=True)
        start_database()
        checked=subprocess.run([str(python),str(runtime/"distribution/check_runtime.py")],input=json.dumps(cfg).encode(),capture_output=True,creationflags=flags,timeout=120)
        if checked.returncode:raise RuntimeError("New version read-only compatibility check failed")
        initialized=subprocess.run([str(node),str(runtime/"dist/cli/main.js"),"check"],input=json.dumps(cfg).encode(),env={**os.environ,"LESSONLOOP_CONFIG_STDIN":"1"},capture_output=True,creationflags=flags,timeout=30)
        if initialized.returncode:raise RuntimeError("New core read-only compatibility check failed")
        call_db("stop")
        shutil.copyfile(runtime/"distribution/launcher.ps1",program/"lessonloop.ps1")
        save_json(program/"active.json",{"installationId":record["installationId"],"runtimeRoot":str(runtime),"dataRoot":str(root),"manifestDigest":target_digest})
        state["phase"]="activated";save_json(update_path,state)
        code=start_components()
        if code!=0:raise RuntimeError("Activated version failed to start")
        print(json.dumps({"status":("rolled_back" if args.action=="rollback" else "updated") if code==0 else "starting","runtimeRoot":str(runtime),"backup":str(backup),"host":"restart_existing_host_sessions","database":"current_data_preserved"}));sys.exit(code)
    except Exception as error:
        if db is not None:db.close()
        state["errorType"]=type(error).__name__
        state["error"]=str(error) if isinstance(error,RuntimeError) else "Update operation failed"
        print(json.dumps({"phase":"rollback","error":state["error"]}),flush=True)
        if switched:
            try:stop_components()
            except Exception:pass
            record=previous_record;runtime=previous_runtime;python=runtime/"python/python.exe";node=runtime/"node/node.exe";cfg=config(secret);save_json(record_path,record)
        if switched:
            shutil.copyfile(runtime/"distribution/launcher.ps1",program/"lessonloop.ps1")
            save_json(active_path,previous_active or {"installationId":record["installationId"],"runtimeRoot":str(runtime),"dataRoot":str(root),"manifestDigest":current_digest})
        state["phase"]="rolled_back_without_restoring_database";save_json(update_path,state)
        if stop_attempted:start_components()
        raise

else:
    env={**os.environ};command=[str(node)]
    if args.action=="cli":env["LESSONLOOP_CONFIG_STDIN"]="1";command+=[str(runtime/"dist/cli/main.js"),*args.arguments];payload=json.dumps(cfg).encode()
    elif args.action=="mcp":env["LESSONLOOP_AGENT_CONFIG_JSON"]=json.dumps({"baseUrl":f"http://127.0.0.1:{record['corePort']}","token":secret["agentToken"]});command+=[str(runtime/"dist/adapters/copilot/mcp.js")];payload=None
    else:env["LESSONLOOP_HOST_CONFIG_JSON"]=json.dumps({"baseUrl":f"http://127.0.0.1:{record['corePort']}","token":secret["hostToken"],"scopeId":record["scopeId"],"allowedRoots":record["allowedRoots"],"stateRoot":str(root/"host-state")});command+=[str(runtime/"dist/adapters/copilot/hook.js"),*args.arguments];payload=sys.stdin.buffer.read()
    # Hidden Windows MCP children need explicit standard handles for bidirectional JSON-RPC.
    stdio={"stdin":sys.stdin,"stdout":sys.stdout,"stderr":sys.stderr} if args.action=="mcp" else {}
    result=subprocess.run(command,input=payload,env=env,creationflags=flags,**stdio)
    sys.exit(result.returncode)
