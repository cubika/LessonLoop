"""Hindsight 0.9.2 structured-schema compatibility shim. No extraction replacement."""
import copy
import json
import hindsight_usage
from importlib.metadata import version
from jsonschema import Draft7Validator, FormatChecker
from pydantic import BaseModel, ConfigDict, model_validator

def install():
    if version("hindsight-api-slim") != "0.9.2":
        raise RuntimeError("Compatibility shim requires Hindsight 0.9.2")
    from hindsight_api.engine.reflect import agent
    hindsight_usage.install()

    async def generate(answer, response_schema, llm_config, reflect_id, max_tokens=None):
        Draft7Validator.check_schema(response_schema)
        validator = Draft7Validator(response_schema, format_checker=FormatChecker())

        invalid_fields = []

        class StructuredResponse(BaseModel):
            model_config = ConfigDict(extra="allow")

            @classmethod
            def model_json_schema(cls, *args, **kwargs):
                return copy.deepcopy(response_schema)

            @model_validator(mode="before")
            @classmethod
            def validate_original_schema(cls, value):
                errors = list(validator.iter_errors(value))
                if errors:
                    # Schema paths contain no source values or model-authored object keys.
                    def leaves(error):
                        if error.context:
                            return [leaf for child in error.context for leaf in leaves(child)]
                        return [error]
                    invalid_fields[:] = ["/".join(map(str, e.absolute_schema_path))+":"+str(e.validator) for error in errors for e in leaves(error)][:8]
                    raise ValueError("Structured response does not match the requested schema")
                return value

        usage = None
        messages=[{"role":"system","content":"Convert the supplied reflection into the exact JSON Schema. Preserve its actual evidence and roles. Do not invent missing observations. Omit optional properties when absent; null is valid only where the schema explicitly allows it. Include required empty arrays. Translate the reflection to the schema field names rather than copying undeclared fields."},{"role":"user","content":json.dumps({"reflection":answer,"schema":response_schema},ensure_ascii=False)}]
        totals={"input_tokens":0,"output_tokens":0,"cached_tokens":0,"thoughts_tokens":0}
        for attempt in range(2):
            invalid_fields.clear()
            usage = None
            try:
                result, usage = await llm_config.call(
                    messages=messages,response_format=StructuredResponse,scope="reflect_structured",strict_schema=True,
                    max_completion_tokens=max_tokens,max_retries=0,skip_validation=True,return_usage=True,
                )
                for name in totals:totals[name]+=getattr(usage,name,0) or 0
                hindsight_usage.add(usage, "structured_conversion")
                value=result.model_dump() if hasattr(result,"model_dump") else result
                StructuredResponse.model_validate(value)
                return agent.StructuredOutputResult(structured_output=value,**totals)
            except Exception as error:
                agent.logger.warning("LessonLoop structured output rejected: type=%s schema_checks=%s",type(error).__name__,invalid_fields)
                if usage is None:
                    hindsight_usage.unknown()
                    agent.logger.warning("LessonLoop failed structured call usage is unknown; do not treat it as zero cost")
                if not invalid_fields or attempt==1:
                    return agent.StructuredOutputResult(**totals)
                messages.append({"role":"user","content":"The previous conversion did not validate. Correct only the JSON shape using the same reflection and schema. Failed schema checks: "+json.dumps(invalid_fields)+". Do not add factual evidence or loosen boundaries."})
        return agent.StructuredOutputResult(**totals)

    agent._generate_structured_output=generate
