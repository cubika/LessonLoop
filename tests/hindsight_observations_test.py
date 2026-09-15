"""Exercise condition checks through the product route without model or DB calls."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from fastapi import HTTPException
from pydantic import ValidationError

path = Path(__file__).parents[1] / "distribution/hindsight_product.py"
spec = importlib.util.spec_from_file_location("product", path)
product = importlib.util.module_from_spec(spec)
spec.loader.exec_module(product)

class Model:
    async def call(self, **kwargs):
        assert set(kwargs["response_format"].model_fields) == {"conditions"}
        return self.result, SimpleNamespace(input_tokens=1, output_tokens=1)

async def main():
    model = Model()
    router = product.LessonLoopProduct({"product_key": "x" * 32}).get_router(
        SimpleNamespace(_reflect_llm_config=model))
    check = next(r.endpoint for r in router.routes if r.path.endswith("check-observations"))
    body = product.ObservationCheck(observations=["Source is generated"],
        conditions=[{"key": "generated", "text": "Is the source generated?"}])
    try:
        product.ObservationCheck(**body.model_dump(), steps=[])
        raise AssertionError("Step tracking must be rejected")
    except ValidationError:
        pass
    for excerpt, expected in [("Source is generated", "true"), ("invented", "unknown")]:
        model.result = {"conditions": [{"key": "generated", "result": "true", "excerpt": excerpt}]}
        result = await check(body, "Bearer " + "x" * 32)
        assert result["result"]["conditions"][0]["result"] == expected
    model.result = {"conditions": []}
    try:
        await check(body, "Bearer " + "x" * 32)
        raise AssertionError("Missing condition must be rejected")
    except HTTPException as error:
        assert error.status_code == 502
    print("Condition-only observation checks: schema, evidence and missing keys passed")

asyncio.run(main())
