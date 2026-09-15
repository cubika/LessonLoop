"""Small, per-user Windows lifecycle helpers. No service or shared account state."""
import json
import os
from pathlib import Path, PurePosixPath
import subprocess

from bundle import unlinked


DATA_ITEMS = (
    "storage/postgres", "backups", "host-state", "secrets.dpapi",
    "database-owner.json", "processes.json", "update-state.json",
    "core.log", "engine.log", "postgres.log", "database-manager.log",
    "update-backup-error.log",
)


def save_json(path, value):
    path = unlinked(path)
    temporary = unlinked(path.with_suffix(path.suffix + ".tmp"))
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def runtime_executables(record, runtime):
    """Use installation bindings; older bundles retain their private executables."""
    runtime = Path(runtime)
    bindings = record.get("runtimeExecutables")
    if bindings is None:
        return {"python": runtime / "python/python.exe", "node": runtime / "node/node.exe",
            "postgres": Path(record.get("databaseRuntimeRoot", runtime / "postgres"))}
    if not isinstance(bindings, dict):
        raise ValueError("Invalid runtime executable bindings")
    result = {}
    for name in ("python", "node", "postgres"):
        value = bindings.get(name)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError("Runtime executable binding must be an absolute path: " + name)
        result[name] = Path(value)
    return result


def owned_layout(record, runtime, data_root):
    runtime, data_root = unlinked(runtime), unlinked(data_root)
    program = unlinked(record.get("programRoot", runtime))
    if str(data_root) != record.get("dataRoot") or str(runtime) != record.get("runtimeRoot"):
        raise ValueError("Installation ownership mismatch")
    if not record.get("installationId") or any(path == Path(path.anchor) for path in (program, data_root)):
        raise ValueError("Invalid installation roots")
    if program == data_root or program.is_relative_to(data_root) or data_root.is_relative_to(program):
        raise ValueError("Program and data roots cannot contain each other")
    if runtime != program and not runtime.is_relative_to(program):
        raise ValueError("Runtime is outside this installation")
    active = json.loads(unlinked(program / "active.json").read_text(encoding="utf-8-sig"))
    if any(active.get(key) != record.get(key) for key in ("installationId", "runtimeRoot", "dataRoot")):
        raise ValueError("Active installation ownership mismatch")
    return program, data_root


def autostart(action, record, runtime, data_root, registry=None):
    program, _ = owned_layout(record, runtime, data_root)
    if registry is None:
        import winreg as registry
    launcher = unlinked(program / "lessonloop.ps1")
    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    command = subprocess.list2cmdline([str(powershell), "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", str(launcher), "start"])
    name = "LessonLoop." + record["installationId"]
    key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
    access = registry.KEY_READ if action == "status" else registry.KEY_READ | registry.KEY_SET_VALUE
    try:
        key = registry.OpenKey(registry.HKEY_CURRENT_USER, key_path, 0, access)
    except FileNotFoundError:
        if action != "enable":
            return {"autostart": "disabled"}
        key = registry.CreateKeyEx(registry.HKEY_CURRENT_USER, key_path, 0, access)
    with key:
        try:
            actual, kind = registry.QueryValueEx(key, name)
        except FileNotFoundError:
            actual, kind = None, None
        if actual is not None and (actual != command or kind != registry.REG_SZ):
            if action == "status":
                return {"autostart": "conflict", "reason": "The startup entry was modified"}
            raise ValueError("Startup entry was modified; it has not been overwritten or removed")
        if action == "enable":
            if not launcher.is_file():
                raise ValueError("Installed launcher missing")
            registry.SetValueEx(key, name, 0, registry.REG_SZ, command)
        elif action == "disable" and actual is not None:
            registry.DeleteValue(key, name)
        elif action not in ("status", "disable"):
            raise ValueError("Use autostart enable, disable, or status")
    enabled = action == "enable" or (action == "status" and actual is not None)
    return {"autostart": "enabled" if enabled else "disabled"}


def checked_tree(path):
    """Reject links before either a recursive walk or deletion can traverse them."""
    path = unlinked(path)
    if path.is_symlink():
        raise ValueError("Linked cleanup path")
    if not path.exists():
        return
    pending = [path]
    while pending:
        current = unlinked(pending.pop())
        if current.is_symlink():
            raise ValueError("Linked cleanup path")
        if current.is_dir():
            pending.extend(current.iterdir())


def installed_manifests(program):
    manifests = [program / "manifest.json"]
    for container in (program / "versions", program / "staging"):
        if container.exists():
            unlinked(container)
            for version in container.iterdir():
                unlinked(version)
                if version.is_dir() and (version / "manifest.json").is_file():
                    manifests.append(version / "manifest.json")
    return manifests


def manifest_paths(program):
    """Remove declared product files and its isolated Python environments."""
    files = set()
    for manifest_path in installed_manifests(program):
        manifest = json.loads(unlinked(manifest_path).read_text(encoding="utf-8-sig"))
        if manifest.get("platform") != "win32-x64" or not isinstance(manifest.get("files"), list):
            raise ValueError("Invalid installed manifest")
        from model_assets import components
        model_files = [item for component in components(manifest) for item in component["files"]]
        for item in [*manifest["files"], *model_files]:
            name = item["path"].replace("\\", "/")
            relative = PurePosixPath(name)
            if relative.is_absolute() or any(part in ("", ".", "..") or ":" in part or part.endswith((".", " ")) for part in name.split("/")):
                raise ValueError("Unsafe installed manifest path")
            target = unlinked(manifest_path.parent / relative)
            if not target.is_relative_to(program) or target == program:
                raise ValueError("Manifest path escapes installation")
            files.add(target.relative_to(program).as_posix())
            if target.suffix == ".py":
                cache = unlinked(target.parent / "__pycache__")
                if cache.is_dir():
                    for bytecode in cache.glob(target.stem + ".*.pyc"):
                        files.add(unlinked(bytecode).relative_to(program).as_posix())
        files.add(manifest_path.relative_to(program).as_posix())
        environment = unlinked(manifest_path.parent / ".venv")
        if environment.exists():
            checked_tree(environment)
            if not (environment / "lessonloop-environment.json").is_file():
                raise ValueError("Python environment is missing its ownership record")
            for target in environment.rglob("*"):
                if target.is_file():
                    files.add(target.relative_to(program).as_posix())
    return sorted(files)


def removal_plan(action, record, runtime, data_root, confirmation=None):
    program, data_root = owned_layout(record, runtime, data_root)
    if action not in ("uninstall", "purge"):
        raise ValueError("Unknown removal action")
    if action == "purge" and confirmation != record["installationId"]:
        raise ValueError("Permanent deletion requires --confirm " + record["installationId"]
            + "; controlled data and backups: " + str(data_root) + "; items: " + ", ".join(DATA_ITEMS))
    items = list(DATA_ITEMS) if action == "purge" else []
    for name in items:
        checked_tree(data_root / name)
    files = manifest_paths(program) if action == "uninstall" else []
    directories = []
    if action == "uninstall":
        for manifest in installed_manifests(program):
            environment = manifest.parent / ".venv"
            if environment.is_dir():
                directories.extend(path.relative_to(program).as_posix() for path in [environment, *environment.rglob("*")] if path.is_dir())
    return {"action": action, "installationId": record["installationId"],
        "programRoot": str(program), "runtimeRoot": str(runtime), "dataRoot": str(data_root),
        "programFiles": files, "programDirectories": directories, "dataItems": items}


def owned_database(record, runtime, data_root, processes=None):
    """A PID alone is insufficient authorization to stop PostgreSQL."""
    if processes is None:
        import psutil as processes
    data_root = unlinked(data_root)
    database = unlinked(data_root / "storage/postgres")
    owner_path = unlinked(data_root / "database-owner.json")
    if not owner_path.exists():
        if database.exists():
            raise ValueError("Database exists without an ownership record")
        return None
    db_runtime = runtime_executables(record, runtime)["postgres"]
    owner = json.loads(owner_path.read_text(encoding="utf-8-sig"))
    if any(owner.get(key) != str(value) for key, value in (("dataRoot", data_root), ("database", database), ("runtime", db_runtime))):
        raise ValueError("Database ownership mismatch")
    pid_path = unlinked(database / "postmaster.pid")
    if not pid_path.exists():
        return None
    try:
        lines = pid_path.read_text(encoding="utf-8").splitlines()
        process = processes.Process(int(lines[0]))
    except processes.NoSuchProcess:
        return None
    except (ValueError, IndexError):
        raise ValueError("Invalid database process record") from None
    try:
        command = process.cmdline()
        owned = Path(process.exe()).resolve() == (db_runtime / "bin/postgres.exe").resolve()
        owned = owned and abs(process.create_time() - float(lines[2])) < 3
        owned = owned and Path(lines[1]).resolve() == database.resolve()
        owned = owned and "-D" in command and Path(command[command.index("-D") + 1]).resolve() == database.resolve()
        if not owned:
            raise ValueError("Recorded database process is no longer owned; cleanup refused")
    except (IndexError, processes.AccessDenied):
        raise ValueError("Database process ownership cannot be confirmed") from None
    return process


def ensure_adapters_closed(program, processes=None, node=None):
    if processes is None:
        import psutil as processes
    program = unlinked(program)
    adapter_processes = []
    for process in processes.process_iter(["exe", "cmdline"]):
        try:
            executable = Path(process.info["exe"]).resolve() if process.info["exe"] else None
            expected = executable == Path(node).resolve() if node else executable and executable.is_relative_to(program) and executable.name.lower() == "node.exe" and executable.parent.name.lower() == "node"
            if expected:
                for argument in (process.info["cmdline"] or [])[1:]:
                    script = Path(argument).resolve()
                    if script.is_relative_to(program) and script.parts[-4:] in (("dist", "adapters", "copilot", "mcp.js"), ("dist", "adapters", "copilot", "hook.js")):
                        adapter_processes.append(process.pid)
                        break
        except (processes.NoSuchProcess, processes.AccessDenied):
            continue
    if adapter_processes:
        raise ValueError("Close active Copilot sessions before uninstalling or clearing data")
