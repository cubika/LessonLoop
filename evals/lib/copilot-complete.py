"""One stateless task-model call through the installed official Hindsight provider."""
import asyncio
import contextlib
import json
import os
import re
import sys
from importlib.metadata import version
from pathlib import Path

def diagnostic(error):
    message = str(error)
    lowered = message.lower()
    category = "provider_error"
    for name, markers in [
        ("authentication", ["not authenticated", "authentication", "sign in", "unauthorized", "login required"]),
        ("quota", ["quota", "usage limit", "weekly limit", "ai credits"]),
        ("permission", ["access is denied", "permission denied", "winerror 5", "eperm", "eacces"]),
        ("timeout", ["timed out", "timeout", "exceeded"]),
        ("runtime_missing", ["no such file", "cannot find", "filenotfound", "cli_path"]),
        ("model_configuration", ["model is not available", "unknown model", "unsupported model"]),
    ]:
        if any(marker in lowered for marker in markers):
            category = name
            break
    for key, value in os.environ.items():
        if value and len(value) >= 4 and any(word in key.upper() for word in ["TOKEN", "SECRET", "PASSWORD", "API_KEY"]):
            message = message.replace(value, "[credential]")
    message = re.sub(r"(?i)(bearer\s+)[^\s,;]+", r"\1[credential]", message)
    message = re.sub(r"https?://[^\s]+", "[endpoint]", message)
    for key in ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME"]:
        value = os.environ.get(key)
        if value:
            message = message.replace(value, "[" + key.lower() + "]")
    return {"error": category, "errorType": type(error).__name__, "message": message[:700]}

async def main():
    request = json.load(sys.stdin)
    if version("hindsight-api-slim") != "0.9.2":
        raise RuntimeError("The evaluation provider requires Hindsight 0.9.2")
    cli = Path(os.environ.get("COPILOT_CLI_PATH") or str(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Links/copilot.exe"))
    if not cli.is_file():
        raise FileNotFoundError("COPILOT_CLI_PATH must name the installed Copilot CLI; the Windows default is the WinGet link")
    os.environ["COPILOT_CLI_PATH"] = str(cli)
    os.environ["COPILOT_SKIP_CLI_DOWNLOAD"] = "1"
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "true"
    if request.get("validate"):
        from hindsight_api.engine.providers.github_copilot_llm import GitHubCopilotLLM
        return {"available": True, "provider": "github-copilot", "authentication": "checked_on_run", "cli": "explicit_installed_path"}
    from hindsight_api.engine.providers.github_copilot_llm import GitHubCopilotLLM
    client = GitHubCopilotLLM(provider="github-copilot", api_key="", base_url="", model=request["model"], timeout=120)
    try:
        text, usage = await client.call(messages=request["messages"], max_completion_tokens=1800, temperature=0, scope="lessonloop_evaluation", max_retries=0, return_usage=True)
        return {"text": text, "usage": usage.model_dump()}
    finally:
        await client.cleanup()

if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(main())
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps(diagnostic(error), ensure_ascii=False))
        sys.exit(1)
