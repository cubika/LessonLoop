"""Authenticated, manifest-bound residual cleanup for pinned Hindsight 0.9.2."""
import hashlib
import hmac
import json
from importlib.metadata import version
from uuid import UUID
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from hindsight_api.extensions.http import HttpExtension

class Manifest(BaseModel):
    model_config=ConfigDict(extra="forbid")
    installation_id:str
    cleanup_id:UUID
    bank_id:str
    generation:int=Field(ge=1)
    observation_history_ids:list[int]=Field(default_factory=list,max_length=256)
    llm_request_ids:list[UUID]=Field(default_factory=list,max_length=256)
    audit_ids:list[UUID]=Field(default_factory=list,max_length=256)
    archive_ids:list[UUID]=Field(default_factory=list,max_length=256)
    manifest_hash:str

class LessonLoopMaintenance(HttpExtension):
    def get_router(self,memory):
        if version("hindsight-api-slim")!="0.9.2":raise RuntimeError("Maintenance requires Hindsight 0.9.2")
        key=self.config.get("maintenance_key","")
        installation_id=self.config.get("installation_id","")
        banks=set(json.loads(self.config.get("owned_banks","[]")))
        schema=self.config.get("schema","hindsight")
        if not key or not installation_id or schema!="hindsight":raise RuntimeError("Explicit maintenance ownership is required")
        router=APIRouter()
        @router.post("/lessonloop/plan-residuals")
        async def cleanup(manifest:Manifest,authorization:str=Header(default="")):
            if not hmac.compare_digest(authorization,"Bearer "+key):raise HTTPException(401,"authentication_required")
            if manifest.installation_id!=installation_id or manifest.bank_id not in banks:raise HTTPException(403,"ownership_mismatch")
            payload=manifest.model_dump(mode="json",exclude={"manifest_hash"})
            expected=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(",",":")).encode()).hexdigest()
            if not hmac.compare_digest(expected,manifest.manifest_hash):raise HTTPException(409,"manifest_changed")
            pool=await memory._get_pool()
            tables=[("observation_history",manifest.observation_history_ids,"bigint",False),("llm_requests",manifest.llm_request_ids,"uuid",False),("audit_log",manifest.audit_ids,"uuid",False),("invalidated_memory_units",manifest.archive_ids,"uuid",True)]
            async with pool.acquire() as connection:
                async with connection.transaction():
                    pending=await connection.fetchval("SELECT count(*) FROM hindsight.async_operations WHERE bank_id=$1 AND status IN ('pending','processing')",manifest.bank_id)
                    if pending:raise HTTPException(409,"native_operations_pending")
                    for table,ids,kind,archive in tables:
                        if len(set(ids))!=len(ids):raise HTTPException(400,"duplicate_manifest_id")
                        rows=await connection.fetch(f"SELECT id,bank_id{',document_id' if archive else ''} FROM hindsight.{table} WHERE id=ANY($1::{kind}[]) FOR UPDATE",ids)
                        if any(row["bank_id"]!=manifest.bank_id or archive and row["document_id"] is not None for row in rows):raise HTTPException(403,"manifest_target_not_owned")
                    counts={}
                    for table,ids,kind,archive in tables:
                        remaining=await connection.fetchval(f"SELECT count(*) FROM hindsight.{table} WHERE bank_id=$1 AND id=ANY($2::{kind}[])",manifest.bank_id,ids)
                        counts[table]={"matched":remaining}
            return {"cleanup_id":str(manifest.cleanup_id),"generation":manifest.generation,"manifest_hash":manifest.manifest_hash,"targets":counts,"mode":"plan_only","coverage":"only_explicit_manifest_ids","erasure_verified":False}
        return router
