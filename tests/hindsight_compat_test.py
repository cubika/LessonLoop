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
        assert kwargs["skip_validation"] is True
        assert kwargs["response_format"].model_json_schema()==schema
        return self.value,SimpleNamespace(input_tokens=1,output_tokens=1,cached_tokens=0,thoughts_tokens=0)
class RecoveringProvider(Provider):
    def __init__(self):super().__init__({"method":{}});self.calls=0
    async def call(self,**kwargs):
        self.calls+=1
        if self.calls==2:
            assert "Failed schema checks" in kwargs["messages"][-1]["content"]
            self.value={"method":{"state":"held"}}
        return await super().call(**kwargs)
class UnavailableProvider:
    def __init__(self,error):self.calls=0;self.error=error
    async def call(self,**kwargs):self.calls+=1;raise self.error
async def main():
    good=await agent._generate_structured_output("test",schema,Provider({"method":{"state":"held"}}),"test")
    assert good.structured_output=={"method":{"state":"held"}}
    bad=await agent._generate_structured_output("test",schema,Provider({"method":{}}),"test")
    assert bad.structured_output is None
    assert bad.input_tokens==2 and bad.output_tokens==2
    nullable=await agent._generate_structured_output("test",schema,Provider({"method":None}),"test")
    assert nullable.structured_output=={"method":None}
    retry=RecoveringProvider()
    repaired=await agent._generate_structured_output("test",schema,retry,"test")
    assert repaired.structured_output=={"method":{"state":"held"}} and retry.calls==2
    assert repaired.input_tokens==2 and repaired.output_tokens==2
    unavailable=UnavailableProvider(TimeoutError())
    failed=await agent._generate_structured_output("test",schema,unavailable,"test")
    assert failed.structured_output is None and unavailable.calls==1
    canceled=UnavailableProvider(asyncio.CancelledError())
    try:await agent._generate_structured_output("test",schema,canceled,"test");raise AssertionError("Cancellation must propagate")
    except asyncio.CancelledError:assert canceled.calls==1


asyncio.run(main())
print("Hindsight compatibility tests passed: original Schema, nested required, enum and nullable.")
