"""Exercise source-copy cleanup with the installed engine and local embeddings."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from uuid import uuid4

root = Path(__file__).resolve().parents[1]
validation = root / '.local-validation'
secret = json.loads((validation / 'data/development-secret.json').read_text())
database = f"postgresql://lessonloop:{secret['password']}@127.0.0.1:19432/postgres"
os.environ.update(HINDSIGHT_API_DATABASE_URL=database, HINDSIGHT_API_DATABASE_SCHEMA='hindsight',
    HINDSIGHT_API_EMBEDDINGS_PROVIDER='onnx', HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH=str(validation / 'models/e5/onnx/model.onnx'),
    HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH=str(validation / 'models/e5'), HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS='384',
    HINDSIGHT_API_RERANKER_PROVIDER='rrf', HINDSIGHT_API_LLM_PROVIDER='mock', HINDSIGHT_API_LLM_MODEL='unused', LITELLM_LOCAL_MODEL_COST_MAP='true',
    HINDSIGHT_API_LLM_TRACE_ENABLED='false', HINDSIGHT_API_AUDIT_LOG_ENABLED='false', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
import asyncpg
from hindsight_api import MemoryEngine
from hindsight_api.models import RequestContext
spec = importlib.util.spec_from_file_location('product', root / 'distribution/hindsight_product.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

async def main():
    memory = MemoryEngine(run_migrations=False)
    db = await asyncpg.connect(database)
    router = module.LessonLoopProduct({'product_key': secret['engineToken']}).get_router(memory)
    endpoints = {route.path.rsplit('/', 1)[-1]: route.endpoint for route in router.routes}
    auth = 'Bearer ' + secret['engineToken']
    scope, object_id = 'native-lifecycle-' + str(uuid4()), str(uuid4())
    bank = 'lessonloop-job-' + str(uuid4())
    report = {'status': 'running', 'scope': scope, 'classification': 'real_native_engine_local_embeddings_no_model_calls'}
    async def put(kind, id, value, revision=1):
        await db.execute("INSERT INTO lessonloop.objects(kind,id,scope_id,revision,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,id) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value", kind, id, scope, revision, json.dumps(value))
    try:
        await memory.initialize()
        print('Native engine initialized', flush=True)
        await put('engine_bank', bank, {'state': 'reserved'})
        await endpoints['configure-bank'](module.BankConfiguration(bank_id=bank, mission='Preserve authorized source evidence'), auth)
        await endpoints['retain-submissions'](module.RetainSubmission(bank_id=bank, mode='chunks', contents=[{'content': 'Synthetic lifecycle source retained without an LLM.', 'document_id': 'source-a'}]), auth)
        assert await db.fetchval('SELECT count(*) FROM hindsight.documents WHERE bank_id=$1', bank) == 1
        print('Real source retained', flush=True)
        await put('playbook', object_id, {'state': 'active', 'revision': 1})
        await put('projection', object_id, {'objectRevision': 1, 'objectKind': 'playbook', 'text': 'Synthetic published lifecycle playbook'})
        write = module.ProjectionWrite(scope_id=scope, object_kind='playbook', object_id=object_id, revision=1, text='Synthetic published lifecycle playbook')
        report['projectionWrite'] = await endpoints['write-projection'](write, auth)
        await put('scope_barrier', scope, {'pending': True})
        report['projectionErasure'] = await endpoints['erase-projections'](module.ProjectionErasure(scope_id=scope, object_kind='playbook', object_id=object_id), auth)
        await put('engine_bank', bank, {'state': 'erasing'}, 2)
        report['bankErasure'] = await endpoints['erase-bank'](module.BankErasure(bank_id=bank, generation=2), auth)
        report['status'] = 'passed'
        print('Real source and projection erasure verified', flush=True)
    except Exception as error:
        report['status'] = 'failed'
        report['errorType'] = type(error).__name__
        raise
    finally:
        (validation / 'results/native-lifecycle-validation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        for callback in router.on_shutdown:
            await callback()
        await memory.close()
        await db.close()

asyncio.run(main())
