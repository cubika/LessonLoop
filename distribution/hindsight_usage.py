"""Numeric-only metering for the pinned 0.9.2 mental-model refresh.

Upstream drops the structured conversion's usage and only persists reflection
usage with full traces. Keep counters on the existing model response instead.
No prompt, completion, source text, or extra database is recorded.
"""
from contextvars import ContextVar
from functools import wraps

FIELDS = ("input_tokens", "output_tokens", "cached_tokens", "thoughts_tokens")
_meter = ContextVar("lessonloop_refresh_usage", default=None)

def add(usage, phase):
    meter = _meter.get()
    if meter is None:
        return
    values = {key: getattr(usage, key, None) if not isinstance(usage, dict) else usage.get(key) for key in FIELDS}
    if any(not isinstance(values[key], (int, float)) or values[key] < 0 for key in FIELDS[:2]):
        meter["complete"] = False
        return
    for key, value in values.items():
        if isinstance(value, (int, float)) and value >= 0:
            meter[key] += value
    meter["phases"].append(phase)

def unknown():
    meter = _meter.get()
    if meter is not None:
        meter["complete"] = False

def install():
    from importlib.metadata import version
    if version("hindsight-api-slim") != "0.9.2":
        raise RuntimeError("Usage adapter requires Hindsight 0.9.2")
    from hindsight_api.engine.memory_engine import MemoryEngine
    if getattr(MemoryEngine.refresh_mental_model, "_lessonloop_metered", False):
        return
    refresh = MemoryEngine.refresh_mental_model
    execute = MemoryEngine._execute_mental_model_refresh
    update = MemoryEngine.update_mental_model

    @wraps(refresh)
    async def measured(self, *args, **kwargs):
        token = _meter.set({**dict.fromkeys(FIELDS, 0), "complete": True, "phases": []})
        try:
            return await refresh(self, *args, **kwargs)
        finally:
            _meter.reset(token)

    @wraps(execute)
    async def executed(self, *args, **kwargs):
        run = await execute(self, *args, **kwargs)
        if run is not None:
            add(run.usage, "reflection")
        return run

    @wraps(update)
    async def updated(self, *args, **kwargs):
        meter = _meter.get()
        response = kwargs.get("reflect_response")
        if meter is not None and response is not None:
            kwargs["reflect_response"] = {**response, "lessonloop_usage": {**meter, "phases": list(meter["phases"])}}
        return await update(self, *args, **kwargs)

    measured._lessonloop_metered = True
    MemoryEngine.refresh_mental_model = measured
    MemoryEngine._execute_mental_model_refresh = executed
    MemoryEngine.update_mental_model = updated
