"""Copilot registration and diagnostics using the official hook/MCP contracts."""
import asyncio
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import urllib.request
import uuid


def private_environment(source=None):
    """Keep account/network settings, but isolate bundled Python and Node loading."""
    ignored = {"PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE", "NODE_PATH", "NODE_OPTIONS", "VIRTUAL_ENV", "CONDA_PREFIX"}
    environment = {key: value for key, value in (os.environ if source is None else source).items() if key.upper() not in ignored}
    environment.update(PYTHONNOUSERSITE="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    return environment


def compatibility_report(runtime, copilot_version, record=None):
    components = json.loads((Path(runtime) / "config/components.json").read_text(encoding="utf-8-sig"))
    tested = components.get("hostCompatibility", {}).get("copilotCliTested", [components["copilotHostObserved"]])
    match = re.search(r"(?<![\d.])\d+\.\d+\.\d+(?:-\d+)?(?![\d-])", copilot_version or "")
    observed = match.group(0) if match else None
    system_reuse = bool((record or {}).get("runtimeExecutables")) or components.get("runtimePolicy") == "system_reuse"
    return {"runtimePolicy": "system_reuse" if system_reuse else "bundled_private",
            "systemPythonNodePostgres": "selected_at_installation" if system_reuse else "not_used_no_version_conflict",
            "minimumVersions": components.get("minimumVersions", {}),
            "selectedExecutables": (record or {}).get("runtimeExecutables", {}),
            "testedVersions": {key: components[key] for key in ["node", "python", "postgresql", "pgvector", "hindsight", "copilotSdk"]},
            "copilotCli": {"observed": observed, "tested": tested,
                "status": "tested" if observed in tested else "untested" if observed else "unknown",
                "policy": "Other versions may run; authentication and protocol checks still apply. Untested does not mean incompatible."}}


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    from bundle import unlinked
    unlinked(path); unlinked(temporary)
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def powershell():
    return str(Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe")


def entries(record):
    program = Path(record.get("programRoot", record["runtimeRoot"]))
    launcher = program / "lessonloop.ps1"
    common = [powershell(), "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(launcher)]
    hooks = {"version": 1, "hooks": {}}
    for event in ["userPromptTransformed", "agentStop", "sessionEnd"]:
        hooks["hooks"][event] = [{"type": "command", "command": subprocess.list2cmdline(common + ["agent-hook", event]), "timeoutSec": 60}]
    mcp = {"type": "stdio", "command": common[0], "args": common[1:] + ["mcp"], "tools": ["*"]}
    return hooks, mcp


def agent_action(action, record, runtime, data_root, copilot_home=None):
    from bundle import unlinked
    root = unlinked(data_root)
    registration = record.get("agentRegistration")
    home = unlinked(copilot_home or (registration or {}).get("home") or os.environ.get("COPILOT_HOME") or (Path.home() / ".copilot"))
    hook_path = unlinked(home / "hooks/lessonloop.json")
    mcp_path = unlinked(home / "mcp-config.json")
    if registration and str(home) != registration["home"]:
        raise RuntimeError("Copilot home differs from the registered location; remove the existing registration first")
    hooks, mcp = entries(record)
    config = json.loads(mcp_path.read_text(encoding="utf-8-sig")) if mcp_path.exists() else {}
    if not isinstance(config, dict) or not isinstance(config.get("mcpServers", {}), dict):
        raise RuntimeError("Copilot MCP config must contain an object")
    current_mcp = config.get("mcpServers", {}).get("lessonloop")
    current_hook = json.loads(hook_path.read_text(encoding="utf-8-sig")) if hook_path.exists() else None
    conflicts = []
    if current_hook is not None and (not registration or digest(current_hook) != registration.get("hookDigest")):
        conflicts.append("lessonloop_hook_modified_or_unowned")
    if current_mcp is not None and (not registration or digest(current_mcp) != registration.get("mcpDigest")):
        conflicts.append("lessonloop_mcp_modified_or_unowned")
    other_hooks = []
    hooks_dir = home / "hooks"
    if hooks_dir.exists():
        other_hooks = [p.name for p in hooks_dir.glob("*hindsight*.json") if p.is_file()]
    if action == "status":
        return {"status": "conflict" if conflicts or other_hooks else "registered" if registration and current_hook and current_mcp else "needs_configuration",
                "home": str(home), "conflicts": conflicts, "otherHindsightHooks": other_hooks,
                "allowedRoots": record.get("allowedRoots", [])}
    if conflicts:
        raise RuntimeError("Copilot configuration changed; keep it and reconcile: " + ", ".join(conflicts))
    if action == "install":
        if not record.get("allowedRoots"):
            raise RuntimeError("Choose a workspace with configure --allow-root before enabling collection")
        if other_hooks:
            raise RuntimeError("Another Hindsight hook is registered; resolve duplicate memory injection first")
        # Use the same flat hooks/MCP format as the official coding-agents installer.
        # Only our named hook file and MCP entry are owned; other entries survive.
        record["agentRegistration"] = {"home": str(home), "hookDigest": digest(hooks), "mcpDigest": digest(mcp)}
        save_json(root / "installation.json", record)
        save_json(hook_path, hooks)
        config.setdefault("mcpServers", {})["lessonloop"] = mcp
        save_json(mcp_path, config)
        return {"status": "registered", "restartCopilot": True, "allowedRoots": record["allowedRoots"]}
    if action == "remove":
        if not registration:
            return {"status": "not_registered"}
        if current_hook is not None:
            hook_path.unlink()
        if current_mcp is not None:
            del config["mcpServers"]["lessonloop"]
            save_json(mcp_path, config)
        record.pop("agentRegistration", None)
        save_json(root / "installation.json", record)
        return {"status": "removed", "restartCopilot": True}
    raise RuntimeError("Expected agent install, remove or status")


def rpc(cfg, operation, value):
    token = next(c["token"] for c in cfg["credentials"] if c["principal"]["channel"] == "user")
    request = urllib.request.Request(f"http://127.0.0.1:{cfg['port']}/v1/rpc",
        data=json.dumps({"operation": operation, "input": value}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Idempotency-Key": str(uuid.uuid4())})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)["result"]


def configure(record, runtime, root, cfg, allowed_roots, enabled=None):
    if allowed_roots:
        selected = []
        for value in allowed_roots:
            path = Path(value).resolve(strict=True)
            if not path.is_dir():
                raise RuntimeError("Collection root must be a directory")
            protected = [Path(record["dataRoot"]).resolve(), Path(record.get("programRoot", runtime)).resolve()]
            if path in [Path.home(), Path(path.anchor)] or any(path == item or path.is_relative_to(item) or item.is_relative_to(path) for item in protected):
                raise RuntimeError("Choose a project directory, not an account or installation root")
            selected.append(str(path))
        record["allowedRoots"] = list(dict.fromkeys(selected))
        save_json(Path(root) / "installation.json", record)
    if enabled is not None:
        if enabled and not record.get("allowedRoots"):
            raise RuntimeError("Choose --allow-root before enabling learning and recommendation")
        settings = next(s for s in rpc(cfg, "settings.get", {}) if s["scopeId"] == record["scopeId"])
        settings = {key: settings[key] for key in ["scopeId", "learning", "recommendation", "review", "notifications"]} | {"expectedRevision": settings["revision"]}
        settings.update(learning=enabled, recommendation=enabled)
        rpc(cfg, "settings.update", settings)
    return {"status": "configured", "allowedRoots": record.get("allowedRoots", []), "learning": enabled}


async def auth_status(cli):
    from copilot import CopilotClient
    os.environ["COPILOT_CLI_PATH"] = cli
    os.environ["COPILOT_SKIP_CLI_DOWNLOAD"] = "1"
    client = CopilotClient(use_logged_in_user=True, mode="copilot-cli", working_directory=str(Path.home()))
    try:
        await asyncio.wait_for(client.start(), 15)
        auth = await asyncio.wait_for(client.get_auth_status(), 10)
        return {"status": "authenticated" if auth.isAuthenticated else "login_required"}
    finally:
        try:
            await asyncio.wait_for(client.stop(), 5)
        except Exception:
            pass


def diagnostics(record, runtime, root, cfg):
    cli = shutil.which("copilot.exe")
    if not cli:
        candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Links/copilot.exe"
        cli = str(candidate) if candidate.is_file() else None
    model = {"status": "cli_missing"}
    version = None
    if cli:
        try:
            version = subprocess.run([cli, "--version"], capture_output=True, text=True, timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout.strip()[:128]
            model = asyncio.run(auth_status(cli))
        except Exception as error:
            model = {"status": "unavailable", "reason": type(error).__name__}
    try:
        agent = agent_action("status", record, runtime, root)
    except Exception as error:
        agent = {"status": "conflict", "reason": type(error).__name__}
    return {"copilotCli": "available" if cli else "missing", "copilotVersion": version,
            "modelAuthentication": model, "hostIntegration": agent,
            "compatibility": compatibility_report(runtime, version, record)}


def open_ui(cfg):
    import webbrowser
    token = next(c["token"] for c in cfg["credentials"] if c["principal"]["channel"] == "user")
    # A fragment never goes to the HTTP server. The page removes it before loading data.
    webbrowser.open(f"http://127.0.0.1:{cfg['port']}/#token={token}")
    return {"status": "opened", "url": f"http://127.0.0.1:{cfg['port']}/"}
