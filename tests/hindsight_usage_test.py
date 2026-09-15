import sys
import asyncio
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).parents[1]/"distribution"))
import hindsight_usage as usage
token = usage._meter.set({**dict.fromkeys(usage.FIELDS, 0), "complete": True, "phases": []})
try:
    usage.add(SimpleNamespace(input_tokens=10, output_tokens=2), "reflection")
    usage.add(SimpleNamespace(input_tokens=3, output_tokens=1), "structured_conversion")
    assert usage._meter.get()["input_tokens"] == 13
    assert usage._meter.get()["output_tokens"] == 3
    assert usage._meter.get()["phases"] == ["reflection", "structured_conversion"]
    usage.unknown()
    assert not usage._meter.get()["complete"]
finally:
    usage._meter.reset(token)
assert usage._meter.get() is None
from hindsight_api.engine.memory_engine import MemoryEngine
async def execute(self, **kwargs):
    return SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=2))
async def update(self, **kwargs):
    return kwargs["reflect_response"]
async def refresh(self, **kwargs):
    await self._execute_mental_model_refresh()
    usage.add(SimpleNamespace(input_tokens=3, output_tokens=1), "structured_conversion")
    return await self.update_mental_model(reflect_response={"structured_output": {"ok": True}})
MemoryEngine.refresh_mental_model = refresh
MemoryEngine._execute_mental_model_refresh = execute
MemoryEngine.update_mental_model = update
usage.install()
engine = object.__new__(MemoryEngine)
async def verify_wrappers():
    results = await asyncio.gather(engine.refresh_mental_model(), engine.refresh_mental_model())
    for result in results:
        assert result["lessonloop_usage"]["input_tokens"] == 13
        assert result["lessonloop_usage"]["output_tokens"] == 3
        assert result["lessonloop_usage"]["complete"] is True
        assert set(result) == {"structured_output", "lessonloop_usage"}
    assert usage._meter.get() is None
asyncio.run(verify_wrappers())
print("Numeric usage: phase totals, unknown failure cost, and context isolation passed")
