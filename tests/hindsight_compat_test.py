import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location("hindsight_compat",Path(__file__).parents[1]/"distribution/hindsight_compat.py")
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.install()
from hindsight_api.engine.reflect import agent
schema={"type":"object","properties":{"method":{"anyOf":[{"type":"object","properties":{"state":{"enum":["active","held"]}},"required":["state"],"additionalProperties":False},{"type":"null"}]}},"required":["method"],"additionalProperties":False}
class Provider:
    def __init__(self,value):self.value=value
    async def call(self,**kwargs):
        assert kwargs["skip_validation"] is False
        assert kwargs["response_format"].model_json_schema()==schema
        return kwargs["response_format"].model_validate(self.value),SimpleNamespace(input_tokens=1,output_tokens=1,cached_tokens=0,thoughts_tokens=0)
async def main():
    good=await agent._generate_structured_output("test",schema,Provider({"method":{"state":"held"}}),"test")
    assert good.structured_output=={"method":{"state":"held"}}
    bad=await agent._generate_structured_output("test",schema,Provider({"method":{}}),"test")
    assert bad.structured_output is None
    nullable=await agent._generate_structured_output("test",schema,Provider({"method":None}),"test")
    assert nullable.structured_output=={"method":None}
asyncio.run(main())
print("Hindsight compatibility tests passed: original Schema, nested required, enum and nullable.")
