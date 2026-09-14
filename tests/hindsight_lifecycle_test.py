"""Real PostgreSQL locks and receipts with controlled native calls; no model calls."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
import asyncpg
from fastapi import HTTPException

root = Path(__file__).resolve().parents[1]
secret = json.loads((root / '.local-validation/data/development-secret.json').read_text())
database = f"postgresql://lessonloop:{secret['password']}@127.0.0.1:19432/postgres"
os.environ.update(HINDSIGHT_API_DATABASE_URL=database, HINDSIGHT_API_LLM_TRACE_ENABLED='false', HINDSIGHT_API_AUDIT_LOG_ENABLED='false')
spec = importlib.util.spec_from_file_location('product', root / 'distribution/hindsight_product.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Native:
    def __init__(self, db):
        self.db = db
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.operations = {}
        self._llm_recorder = SimpleNamespace(_pending={})
        self._config_resolver = self
    async def resolve_full_config(self, *args):
        return SimpleNamespace(audit_log_enabled=False)
    async def update_bank(self, bank, **kwargs):
        await self.db.execute('INSERT INTO hindsight.banks(bank_id) VALUES($1) ON CONFLICT DO NOTHING', bank)
    async def retain_batch_async(self, bank, contents, **kwargs):
        self.entered.set()
        await self.release.wait()
        for item in contents:
            await self.db.execute('INSERT INTO hindsight.documents(id,bank_id,original_text) VALUES($1,$2,$3) ON CONFLICT(id,bank_id) DO UPDATE SET original_text=EXCLUDED.original_text', item['document_id'], bank, item['content'])
        return [], SimpleNamespace(input_tokens=0, output_tokens=0)
    async def delete_document(self, document, bank, **kwargs):
        await self.db.execute('DELETE FROM hindsight.documents WHERE id=$1 AND bank_id=$2', document, bank)
    async def get_operation_status(self, bank, operation, **kwargs):
        return {'status': self.operations.get(operation, 'not_found')}
    async def cancel_operation(self, bank, operation, **kwargs):
        await self.db.execute("UPDATE hindsight.async_operations SET status='cancelled' WHERE bank_id=$1 AND operation_id=$2 AND status='pending'", bank, uuid4() if not operation else __import__('uuid').UUID(operation))
    async def delete_bank(self, bank, **kwargs):
        await self.db.execute('DELETE FROM hindsight.banks WHERE bank_id=$1', bank)

async def rejected(coro, detail):
    try:
        await coro
        raise AssertionError('Expected rejection: ' + detail)
    except HTTPException as error:
        assert error.detail == detail, error.detail

async def main():
    db = await asyncpg.connect(database)
    native = Native(db)
    router = module.LessonLoopProduct({'product_key': secret['engineToken']}).get_router(native)
    endpoints = {r.path.rsplit('/', 1)[-1]: r.endpoint for r in router.routes}
    auth = 'Bearer ' + secret['engineToken']
    scope = 'lifecycle-test-' + str(uuid4())
    object_id = str(uuid4())
    bank = 'lessonloop-job-' + str(uuid4())
    async def put(kind, id, value):
        await db.execute("INSERT INTO lessonloop.objects(kind,id,scope_id,revision,value) VALUES($1,$2,$3,1,$4) ON CONFLICT(kind,id) DO UPDATE SET value=EXCLUDED.value", kind, id, scope, json.dumps(value))
    try:
        await put('engine_bank', bank, {'state': 'reserved'})
        await native.update_bank(bank)
        operation = str(uuid4())
        result = await endpoints['cancel-retain-submission'](module.RetainCancellation(bank_id=bank, operation_id=operation), auth)
        assert result == {'submission_canceled': True, 'operation_status': 'not_found'}
        await rejected(endpoints['retain-submissions'](module.RetainSubmission(bank_id=bank, operation_id=operation, mode='learning', contents=[{'content': 'late source'}]), auth), 'retain_submission_canceled')
        pending, processing = uuid4(), uuid4()
        for id, state in [(pending, 'pending'), (processing, 'processing')]:
            await db.execute("INSERT INTO hindsight.async_operations(operation_id,bank_id,operation_type,status) VALUES($1,$2,'retain',$3)", id, bank, state)
        await put('engine_bank', bank, {'state': 'erasing'})
        result = await endpoints['drain-bank'](module.BankDrain(bank_id=bank), auth)
        assert result == {'drained': False, 'remaining': 1}
        assert await db.fetchval('SELECT status FROM hindsight.async_operations WHERE operation_id=$1', pending) == 'cancelled'
        await rejected(endpoints['configure-bank'](module.BankConfiguration(bank_id=bank, mission='late configuration'), auth), 'bank_not_writable')
        await db.execute("UPDATE hindsight.async_operations SET status='completed' WHERE operation_id=$1", processing)
        assert (await endpoints['drain-bank'](module.BankDrain(bank_id=bank), auth))['drained']
        assert (await endpoints['erase-bank'](module.BankErasure(bank_id=bank, generation=1), auth))['erased']
        await put('method', object_id, {'state': 'active', 'revision': 1})
        await put('projection', object_id, {'objectRevision': 1, 'objectKind': 'method', 'text': 'private source'})
        write = module.ProjectionWrite(scope_id=scope, object_kind='method', object_id=object_id, revision=1, text='private source')
        running = asyncio.create_task(endpoints['write-projection'](write, auth))
        await native.entered.wait()
        await put('scope_barrier', scope, {'pending': True})
        erasure = asyncio.create_task(endpoints['erase-projections'](module.ProjectionErasure(scope_id=scope, object_kind='method', object_id=object_id), auth))
        await asyncio.sleep(.1)
        assert not erasure.done(), 'Erasure must wait for the server-side write, even after caller timeout'
        native.release.set()
        await running
        assert (await erasure)['deleted'] == 1
        await rejected(endpoints['write-projection'](write, auth), 'projection_changed')
        assert await db.fetchval("SELECT count(*) FROM hindsight.documents WHERE id=$1", f'method-{object_id}-1') == 0
        await put('scope_barrier', scope, {'pending': False})
        await put('method', object_id, {'state': 'disabled', 'revision': 2})
        await rejected(endpoints['write-projection'](write, auth), 'projection_changed')
        print('Lifecycle gates passed: unsubmitted retain closure, child drain, erasure, delayed projection write, stale replay.')
    finally:
        native.release.set()
        for callback in router.on_shutdown:
            await callback()
        await db.close()

asyncio.run(main())
