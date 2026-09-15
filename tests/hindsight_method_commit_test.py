"""Real engine + database + official extension. Explicit URL must name a disposable test DB."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from uuid import uuid4

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'distribution'))
url = os.environ['LESSONLOOP_TEST_DATABASE_URL']
assert urlsplit(url).path.startswith('/ll_native_methods_'), 'Use a dedicated test database'
os.environ.update(HINDSIGHT_API_DATABASE_URL=url, HINDSIGHT_API_DATABASE_SCHEMA='hindsight',
    HINDSIGHT_API_LLM_PROVIDER='mock', HINDSIGHT_API_LLM_MODEL='unused',
    HINDSIGHT_API_LLM_TRACE_ENABLED='false', HINDSIGHT_API_AUDIT_LOG_ENABLED='false',
    HINDSIGHT_API_ENABLE_MENTAL_MODEL_HISTORY='false',
    HINDSIGHT_API_MAINTENANCE_START_JITTER_SECONDS='86400', LITELLM_LOCAL_MODEL_COST_MAP='true')
import asyncpg
import httpx
from hindsight_api import MemoryEngine
from hindsight_api.models import RequestContext
from hindsight_api.extensions.operation_validator import OperationValidationError
from hindsight_api.api.http import create_app
from hindsight_methods import PlaybookGuard, bank_for
from hindsight_product import LessonLoopProduct

async def main():
    engine = MemoryEngine(operation_validator=PlaybookGuard({}))
    db = await asyncpg.connect(url)
    key = 'test-only-' + 'a' * 40
    scope, identifier, support_id = str(uuid4()), str(uuid4()), str(uuid4())
    bank = bank_for(scope, identifier)
    ctx = RequestContext()
    content = {'title': 'Checked playbook', 'goal': 'Preserve generated changes', 'topics': [],
               'conditions': [], 'exceptions': [], 'steps': [{'stepId': 's1', 'instruction': 'Edit template', 'supportIndexes': [0]}],
               'completionChecks': [{'text': 'Regenerate and check'}], 'stopConditions': []}
    async def put(kind, id, value):
        await db.execute("INSERT INTO lessonloop.objects VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,id) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value", kind,id,scope,value['revision'],json.dumps(value))
    async def stage(revision, body):
        token = str(uuid4())
        await put('playbook_write', identifier, {'id':identifier,'scopeId':scope,'revision':revision,'token':token,'hash':'b'*64,**({'content':body} if body else {})})
        return token
    checks = []
    app = None
    try:
        await engine.initialize()
        await db.execute('CREATE SCHEMA lessonloop; CREATE TABLE lessonloop.objects(kind text,id text,scope_id text,revision bigint,value jsonb,PRIMARY KEY(kind,id))')
        await put('experience', support_id, {'id':support_id,'scopeId':scope,'revision':1,'state':'active','sourceFingerprints':['source-a'],'derivedFrom':[]})
        await put('playbook', identifier, {'id':identifier,'scopeId':scope,'revision':1,'state':'active','contentHash':'b'*64,'supportRefs':[{'id':support_id,'revision':1}]})
        app = create_app(engine, initialize_memory=False, http_extension=LessonLoopProduct({'product_key':key}))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test',headers={'Authorization':'Bearer '+key}) as client:
            async def commit(token):
                return await client.post('/ext/lessonloop/commit-playbook',json={'id':identifier,'token':token})
            token = await stage(1, content)
            response = await commit(token)
            assert response.status_code == 200, response.text
            assert (await commit(token)).status_code == 200
            current = await engine.get_mental_model(bank,'current',request_context=ctx)
            assert current['reflect_response']['structured_output'] == content
            assert await db.fetchval('SELECT count(*) FROM hindsight.mental_model_history WHERE bank_id=$1',bank) == 0
            checks.append('validated content, idempotent retry, no native history')
            try:
                await engine.update_mental_model(bank,'current',content='unreviewed',request_context=ctx)
                raise AssertionError('Direct edit must be rejected')
            except OperationValidationError:
                pass
            try:
                await engine.refresh_mental_model(bank,'current',request_context=ctx)
                raise AssertionError('Direct refresh must be rejected')
            except OperationValidationError:
                pass
            checks.append('direct edit and refresh cannot bypass validation')
            next_content = {**content,'title':'Reviewed v2'}
            # Same hash is intentionally reused here to test readback integrity.
            token2 = await stage(1, next_content)
            assert (await commit(token)).status_code == 409
            assert (await commit(token2)).status_code == 409
            checks.append('old token rejected after ABA; content mismatch detected')
            await put('playbook_write', identifier, {'id':identifier,'scopeId':scope,'revision':2,'token':token2,'hash':'c'*64,'content':next_content})
            await put('playbook', identifier, {'id':identifier,'scopeId':scope,'revision':2,'state':'active','contentHash':'c'*64,'supportRefs':[{'id':support_id,'revision':1}]})
            await put('source', 'source-a', {'revision':1,'blocked':True})
            assert (await commit(token2)).status_code == 409
            assert (await engine.get_mental_model(bank,'current',request_context=ctx))['reflect_response']['structured_output'] == content
            await put('source', 'source-a', {'revision':2,'blocked':False})
            checks.append('source withdrawal blocks write and preserves old body')
            await put('experience', support_id, {'id':support_id,'scopeId':scope,'revision':1,'state':'active','sourceFingerprints':['source-a'],'derivedFrom':[], 'validUntil':'2000-01-01T00:00:00Z'})
            assert (await commit(token2)).status_code == 409
            assert (await engine.get_mental_model(bank,'current',request_context=ctx))['reflect_response']['structured_output'] == content
            await put('experience', support_id, {'id':support_id,'scopeId':scope,'revision':1,'state':'active','sourceFingerprints':['source-a'],'derivedFrom':[]})
            checks.append('expiry during pending commit preserves prior content')
            # Fail before native UPDATE and verify the previous body survives.
            original = engine.update_mental_model
            async def interrupt(*args,**kwargs):
                raise ConnectionError('Injected interruption before structured body commit')
            engine.update_mental_model = interrupt
            try:
                await commit(token2)
            except ConnectionError:
                pass
            finally:
                engine.update_mental_model = original
            assert (await engine.get_mental_model(bank,'current',request_context=ctx))['reflect_response']['structured_output'] == content
            assert (await commit(token2)).status_code == 200
            assert (await engine.get_mental_model(bank,'current',request_context=ctx))['reflect_response']['structured_output'] == next_content
            assert await db.fetchval('SELECT count(*) FROM hindsight.mental_model_history WHERE bank_id=$1',bank) == 0
            checks.append('interrupted replacement resumes exact candidate without history')
            # Native commit cannot pass an in-flight product/control transaction.
            await db.execute('BEGIN; SELECT pg_advisory_xact_lock(761259484)')
            pending = asyncio.create_task(commit(token2))
            await asyncio.sleep(0.1)
            assert not pending.done()
            await put('control', identifier, {'revision':1,'reason':'user_disabled'})
            await db.execute('COMMIT')
            assert (await pending).status_code == 409
            checks.append('product lock serializes control and commit')
            await db.execute("DELETE FROM lessonloop.objects WHERE kind='playbook' AND id=$1",identifier)
            delete_token = await stage(3,None)
            assert (await commit(delete_token)).status_code == 200
            assert await db.fetchval('SELECT count(*) FROM hindsight.mental_models WHERE bank_id=$1',bank) == 0
            assert await db.fetchval('SELECT count(*) FROM hindsight.mental_model_history WHERE bank_id=$1',bank) == 0
            checks.append('delete confirms body and history erasure')
            job_id = str(uuid4())
            job_bank = 'lessonloop-job-' + job_id
            await engine.create_mental_model(job_bank, 'Transient candidate', 'Synthetic query', 'Temporary draft', mental_model_id='job-'+job_id, request_context=ctx)
            await put('job', job_id, {'id':job_id,'scopeId':scope,'revision':1,'status':'running','nativeIsolation':'job'})
            assert (await client.post('/ext/lessonloop/clear-playbook-candidates',json={'id':job_id,'kind':'job'})).status_code == 409
            await put('job', job_id, {'id':job_id,'scopeId':scope,'revision':2,'status':'completed','nativeIsolation':'job'})
            assert (await client.post('/ext/lessonloop/clear-playbook-candidates',json={'id':job_id,'kind':'job'})).status_code == 200
            assert await engine.get_mental_model(job_bank,'job-'+job_id,request_context=ctx) is None
            checks.append('terminal candidate models are removed; running candidates retained')
        print(json.dumps({'status':'passed','checks':checks,'llmCalls':0}))
    finally:
        await engine.close()
        await db.close()

asyncio.run(main())
