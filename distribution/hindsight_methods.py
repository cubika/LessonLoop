"""Single current method body. Product validation authorizes a durable write intent."""
import hashlib
import hmac
import json
from datetime import datetime, timezone
from contextvars import ContextVar
from fastapi import Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from hindsight_api.models import RequestContext
from hindsight_api.extensions.operation_validator import OperationValidatorExtension, ValidationResult

owned_write = ContextVar("lessonloop_method_write", default=False)
PREFIX = "lessonloop-method-"

class MethodGuard(OperationValidatorExtension):
    async def validate_retain(self, ctx):
        return self.check(ctx.bank_id)
    async def validate_recall(self, ctx):
        return ValidationResult.accept()
    async def validate_reflect(self, ctx):
        return self.check(ctx.bank_id)
    async def validate_bank_write(self, ctx):
        return self.check(ctx.bank_id)
    async def validate_mental_model_refresh(self, ctx):
        return self.check(ctx.bank_id)
    async def validate_create_bank(self, ctx):
        return self.check(ctx.bank_id)
    def check(self, bank):
        return (ValidationResult.reject("method_content_requires_validated_commit")
                if bank.startswith(PREFIX) and not owned_write.get() else ValidationResult.accept())

class Commit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)
    token: str = Field(min_length=36, max_length=36)

class Read(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)
    scope_id: str = Field(min_length=1, max_length=128)
    hash: str = Field(pattern=r"^[a-f0-9]{64}$")

class CandidateCleanup(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    kind: str = Field(pattern=r"^(job|revision_review)$")

def bank_for(scope, identifier):
    return PREFIX + hashlib.sha256((scope + "\0" + identifier).encode()).hexdigest()[:32]

def decode(value):
    return json.loads(value) if isinstance(value, str) else value

def install(router, memory, metadata_pool, key):
    async def authenticate(authorization):
        if not hmac.compare_digest(authorization, "Bearer " + key):
            raise HTTPException(401, "authentication_required")
        return RequestContext(api_key=key)

    @router.post("/lessonloop/clear-method-candidates")
    async def clear_candidates(body: CandidateCleanup, authorization: str = Header(default="")):
        context = await authenticate(authorization)
        pool = await metadata_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("SELECT pg_advisory_xact_lock(761259484)")
                record = decode(await conn.fetchval("SELECT value FROM lessonloop.objects WHERE kind=$1 AND id=$2", body.kind, body.id))
                if not record or record.get("status") not in ("completed", "failed", "canceled") or record.get("nativeIsolation") != "job":
                    raise HTTPException(409, "candidate_job_not_terminal")
                bank = "lessonloop-job-" + body.id
                await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,816028))", bank)
                if await conn.fetchval("SELECT EXISTS(SELECT 1 FROM hindsight.async_operations WHERE bank_id=$1 AND status IN ('pending','processing'))", bank):
                    raise HTTPException(409, "candidate_operations_pending")
                await conn.execute("UPDATE lessonloop_engine.model_submissions SET canceled=true WHERE bank_id=$1", bank)
                models = await conn.fetch("SELECT id FROM hindsight.mental_models WHERE bank_id=$1", bank)
                for model in models:
                    await memory.delete_mental_model(bank, model["id"], request_context=context)
        return {"cleared": True}

    @router.post("/lessonloop/method-content")
    async def read(body: Read, authorization: str = Header(default="")):
        context = await authenticate(authorization)
        model = await memory.get_mental_model(bank_for(body.scope_id, body.id), "current", request_context=context)
        response = (model or {}).get("reflect_response") or {}
        if response.get("content_hash") != body.hash:
            raise HTTPException(409, "method_content_unavailable")
        return response["structured_output"]

    @router.post("/lessonloop/commit-method")
    async def commit(body: Commit, authorization: str = Header(default="")):
        context = await authenticate(authorization)
        from hindsight_api.config import get_config
        if get_config().enable_mental_model_history:
            raise HTTPException(409, "validated_methods_require_history_disabled")
        pool = await metadata_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL lock_timeout='20s'")
                await conn.execute("SELECT pg_advisory_xact_lock(761259484)")
                pending = decode(await conn.fetchval("SELECT value FROM lessonloop.objects WHERE kind='method_write' AND id=$1", body.id))
                if not pending or pending["token"] != body.token:
                    raise HTTPException(409, "method_write_changed")
                method = decode(await conn.fetchval("SELECT value FROM lessonloop.objects WHERE kind='method' AND id=$1", body.id))
                content = pending.get("content")
                bank = bank_for(pending["scopeId"], body.id)
                if content is not None:
                    if not method or method["contentHash"] != pending["hash"] or method["state"] != "active":
                        raise HTTPException(409, "method_not_publishable")
                    def usable(value):
                        now = datetime.now(timezone.utc)
                        return value.get("applicability") != "unknown" and all(
                            not value.get(field) or predicate(datetime.fromisoformat(value[field].replace("Z", "+00:00")), now)
                            for field, predicate in [("validFrom", lambda date, now: date <= now), ("validUntil", lambda date, now: date > now)])
                    if not usable(method):
                        raise HTTPException(409, "method_expired")
                    blocked = await conn.fetchval("SELECT EXISTS(SELECT 1 FROM lessonloop.objects WHERE (kind='scope_barrier' AND id=$1 AND value->>'pending'='true') OR (kind='control' AND id=$2))", pending["scopeId"], body.id)
                    if blocked:
                        raise HTTPException(409, "method_control_changed")
                    visited = set()
                    async def support(ref, depth=0):
                        if depth > 5 or ref["id"] in visited or len(visited) >= 32:
                            raise HTTPException(409, "method_support_budget")
                        visited.add(ref["id"])
                        exp = decode(await conn.fetchval("SELECT value FROM lessonloop.objects WHERE kind='experience' AND id=$1", ref["id"]))
                        if not exp or exp["revision"] != ref["revision"] or exp["scopeId"] != pending["scopeId"] or exp["state"] != "active":
                            raise HTTPException(409, "method_support_changed")
                        if not usable(exp):
                            raise HTTPException(409, "method_support_expired")
                        if await conn.fetchval("SELECT EXISTS(SELECT 1 FROM lessonloop.objects WHERE (kind='source' AND id=ANY($1::text[]) AND value->>'blocked'='true') OR (kind='control' AND id=$2))", exp["sourceFingerprints"], exp["id"]):
                            raise HTTPException(409, "method_source_changed")
                        for parent in exp.get("derivedFrom", []):
                            if parent["id"] not in visited:
                                await support(parent, depth + 1)
                    for ref in method["supportRefs"]:
                        if ref["id"] not in visited:
                            await support(ref)
                elif method:
                    raise HTTPException(409, "method_delete_changed")
                token = owned_write.set(True)
                try:
                    model = await memory.get_mental_model(bank, "current", request_context=context)
                    if content is None:
                        await memory.delete_bank(bank, request_context=context)
                    elif ((model or {}).get("reflect_response") or {}).get("content_hash") != pending["hash"]:
                        # A retry reads the exact committed hash; it never regenerates.
                        text = json.dumps(content, ensure_ascii=False, indent=2)
                        if not model:
                            await memory.create_mental_model(bank, content["title"], "Validated LessonLoop method", text,
                                mental_model_id="current", trigger={"refresh_after_consolidation": False}, request_context=context)
                        # Native update writes Markdown and JSON in one SQL statement.
                        # An embedding/write failure leaves the previous body untouched.
                        await memory.update_mental_model(bank, "current", name=content["title"], content=text,
                            reflect_response={"structured_output": content, "content_hash": pending["hash"]}, request_context=context)
                    confirmed = await memory.get_mental_model(bank, "current", request_context=context)
                    if content is not None and ((confirmed or {}).get("reflect_response") or {}).get("structured_output") != content:
                        raise HTTPException(409, "method_readback_mismatch")
                    if content is None and confirmed is not None:
                        raise HTTPException(409, "method_cleanup_incomplete")
                finally:
                    owned_write.reset(token)
        return {"confirmed": True}
