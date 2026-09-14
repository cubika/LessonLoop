"""Hindsight 0.9.2 structured-schema compatibility shim. No extraction replacement."""
import copy
import json
from importlib.metadata import version
from jsonschema import Draft7Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, model_validator

def install():
    if version("hindsight-api-slim") != "0.9.2":
        raise RuntimeError("Compatibility shim requires Hindsight 0.9.2")
    from hindsight_api.engine.reflect import agent

    async def generate(answer, response_schema, llm_config, reflect_id, max_tokens=None):
        Draft7Validator.check_schema(response_schema)
        validator = Draft7Validator(response_schema, format_checker=FormatChecker())

        class StructuredResponse(BaseModel):
            model_config = ConfigDict(extra="allow")

            @classmethod
            def model_json_schema(cls, *args, **kwargs):
                return copy.deepcopy(response_schema)

            @model_validator(mode="before")
            @classmethod
            def validate_original_schema(cls, value):
                error = next(validator.iter_errors(value), None)
                if error:
                    # Values may contain source data; report only the schema path.
                    raise ValueError("Invalid structured field at " + "/".join(map(str, error.absolute_path)))
                return value

        usage = None
        try:
            result, usage = await llm_config.call(
                messages=[{"role":"system","content":"Convert the supplied reflection into the exact JSON Schema. Preserve its actual evidence and roles. Do not invent missing observations. Return no proposal when the evidence does not justify one."},{"role":"user","content":json.dumps({"reflection":answer,"schema":response_schema},ensure_ascii=False)}],
                response_format=StructuredResponse, scope="reflect_structured", strict_schema=True,
                max_completion_tokens=max_tokens, max_retries=1, initial_backoff=0.25, max_backoff=1,
                skip_validation=False, return_usage=True,
            )
            value=result.model_dump() if hasattr(result,"model_dump") else result
            validator.validate(value)
            return agent.StructuredOutputResult(structured_output=value,input_tokens=usage.input_tokens,output_tokens=usage.output_tokens,cached_tokens=usage.cached_tokens,thoughts_tokens=usage.thoughts_tokens)
        except Exception:
            agent.logger.warning("LessonLoop structured output did not pass the original JSON Schema")
            if usage is not None:
                return agent.StructuredOutputResult(input_tokens=usage.input_tokens,output_tokens=usage.output_tokens,cached_tokens=usage.cached_tokens,thoughts_tokens=usage.thoughts_tokens)
            agent.logger.warning("LessonLoop failed structured call usage is unknown; do not treat it as zero cost")
            return agent.StructuredOutputResult()

    agent._generate_structured_output=generate
