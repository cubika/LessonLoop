"""Real PostgreSQL metadata transactions, fake native operations; no model calls."""
import asyncio
import importlib.util
import json
import os
import sys
from urllib.parse import urlsplit
from pathlib import Path
from uuid import uuid4
import asyncpg
from fastapi import HTTPException

root=Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'distribution'))
database = os.environ['LESSONLOOP_TEST_DATABASE_URL']
assert urlsplit(database).path.startswith('/ll_native_methods_'), 'Use a dedicated test database'
secret = {'engineToken': 'test-only-' + 'a' * 40}
os.environ["HINDSIGHT_API_DATABASE_URL"]=database
spec=importlib.util.spec_from_file_location("product",root/"distribution/hindsight_product.py");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Native:
    def __init__(self):self.model=None;self.operation=None;self.creates=0;self.submits=0;self.fail_once=True
    async def _authenticate_tenant(self,context):assert context.api_key==secret["engineToken"]
    async def get_mental_model(self,*args,**kwargs):return self.model
    async def create_mental_model(self,**kwargs):self.creates+=1;self.model={"source_query":kwargs["source_query"],"tags":kwargs["tags"],"trigger":kwargs["trigger"]}
    async def list_operations(self,*args,**kwargs):return{"operations":[{"id":self.operation,"mental_model_id":self.id}] if self.operation else [],"total":int(self.operation is not None)}
    async def submit_async_refresh_mental_model(self,bank,model,**kwargs):
        self.submits+=1
        if self.fail_once:self.fail_once=False;raise ConnectionError("simulated lost submission before queue")
        self.operation=str(uuid4());self.id=model;return{"operation_id":self.operation}
    async def get_operation_status(self,*args,**kwargs):return{"status":"pending" if self.operation else "not_found"}
async def main():
    bank="lessonloop-job-"+str(uuid4());model="job-"+str(uuid4());conn=await asyncpg.connect(database)
    await conn.execute("INSERT INTO hindsight.banks(bank_id) VALUES($1)",bank)
    await conn.execute("INSERT INTO lessonloop.objects(kind,id,scope_id,revision,value) VALUES('engine_bank',$1,'test',1,$2)",bank,json.dumps({"state":"reserved"}))
    native=Native();ext=module.LessonLoopProduct({"product_key":secret["engineToken"]});router=ext.get_router(native);endpoint=next(route.endpoint for route in router.routes if route.path.endswith("model-submissions"))
    body=module.ModelSubmission(bank_id=bank,model_id=model,query="Public synthetic schema test",tags=["source:test"],response_schema={"type":"object"})
    try:
        try:await endpoint(body,"Bearer "+secret["engineToken"])
        except ConnectionError:pass
        result=await endpoint(body,"Bearer "+secret["engineToken"])
        duplicate=await endpoint(body,"Bearer "+secret["engineToken"])
        assert result["operation_id"]==duplicate["operation_id"] and native.creates==1 and native.submits==2
        changed=body.model_copy(update={"tags":["source:other"]})
        try:await endpoint(changed,"Bearer "+secret["engineToken"]);raise AssertionError("conflict expected")
        except HTTPException as error:assert error.status_code==409
        canceled_model="job-"+str(uuid4());cancel=next(route.endpoint for route in router.routes if route.path.endswith("cancel-model-submission"))
        await cancel(module.CancelSubmission(bank_id=bank,model_id=canceled_model),"Bearer "+secret["engineToken"])
        try:await endpoint(body.model_copy(update={"model_id":canceled_model}),"Bearer "+secret["engineToken"]);raise AssertionError("late submission expected to fail")
        except HTTPException as error:assert error.status_code==409
        await conn.execute("UPDATE lessonloop.objects SET value=$2 WHERE kind='engine_bank' AND id=$1",bank,json.dumps({"state":"erased"}))
        try:await endpoint(body,"Bearer "+secret["engineToken"]);raise AssertionError("tombstone expected")
        except HTTPException as error:assert error.status_code==409
        print("Submission recovery, duplicate, content conflict and tombstone tests passed; no model calls.")
    finally:
        for callback in router.on_shutdown:await callback()
        await conn.close()
asyncio.run(main())
