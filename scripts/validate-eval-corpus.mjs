import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'evals/provenloop');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(path.join(directory, name), 'utf8');
const errors = [];
const check = (value, message) => { if (!value) errors.push(message); };
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const materialsText = read('materials.json');
const selectionsText = read('selections.json');
const materials = JSON.parse(materialsText);
const selections = JSON.parse(selectionsText);
const manifest = JSON.parse(read('manifest.json'));
check(materials.corpusId === manifest.corpusId && selections.corpusId === materials.corpusId, 'Corpus identity mismatch');
check(materials.status === 'needs_oracle_review' && materials.labels === 'not_migrated' && materials.taskExecution === 'not_implemented', 'Readiness incorrectly promoted');
check(materials.split === 'development' && materials.sourceKind === 'authored_replay', 'Source or split incorrectly promoted');
check(sha256(materialsText) === manifest.outputs.materials.sha256, 'Materials hash mismatch');
check(sha256(selectionsText) === manifest.outputs.selections.sha256, 'Selections hash mismatch');
const definitions = ['docs/05-delivery-and-validation.md', 'docs/08-connectors.md'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const acceptanceIds = new Set([...definitions.matchAll(/^\| ([A-Z]\d{2}) \|/gm)].map(match => match[1]));
const index = new Map(manifest.inventory.map(item => [item.id, item]));
const sourceKeys = new Set(manifest.sources.map(item => item.key));
check(index.size === 92 && manifest.inventory.length === 92, 'Expected 92 unique source entries');
check(materials.cases.length === 48, 'Expected 48 selected windows');
check(new Set(materials.cases.map(item => item.id)).size === 48, 'Duplicate material ID');
for (const source of manifest.sources) {
  check(validHash(source.artifactSha256) && validHash(source.codeSha256), 'Invalid source hashes: ' + source.key);
  check(!path.isAbsolute(source.artifact) && !source.artifact.split(/[\\/]/).includes('..'), 'Invalid source location: ' + source.key);
}
const counts = { selected: 0, deferred: 0, rebuild: 0 };
for (const item of manifest.inventory) {
  check(Object.hasOwn(counts, item.decision), 'Unknown decision: ' + item.id);
  counts[item.decision]++;
  check(sourceKeys.has(item.source.corpus) && validHash(item.source.caseSha256) && /^\/cases\/\d+$/.test(item.source.pointer), 'Invalid provenance: ' + item.id);
  check(typeof item.reason === 'string' && item.reason.length > 0, 'Missing selection reason: ' + item.id);
  for (const id of item.acceptanceIds ?? []) check(acceptanceIds.has(id), 'Unknown acceptance ID ' + id + ': ' + item.id);
}
for (const key of Object.keys(counts)) check(counts[key] === manifest.counts.decisions[key], 'Decision count mismatch: ' + key);
check(manifest.counts.available === 92 && manifest.counts.selected === 48 && manifest.counts.smoke === 16, 'Manifest totals changed');
const byCorpus = {};
for (const item of materials.cases) {
  const origin = index.get(item.id);
  check(origin?.decision === 'selected' && JSON.stringify(origin.source) === JSON.stringify(item.source), 'Selection/provenance mismatch: ' + item.id);
  check(item.split === 'development' && item.status === 'needs_oracle_review', 'Invalid readiness: ' + item.id);
  check(typeof item.family === 'string' && item.reviewNotes?.length > 0 && item.acceptanceIds?.length > 0, 'Missing review context: ' + item.id);
  check(item.inputSha256 === sha256(JSON.stringify(item.input)), 'Input hash mismatch: ' + item.id);
  check(!Object.hasOwn(item, 'expected') && !Object.hasOwn(item, 'passed') && !Object.hasOwn(item, 'modelOutput'), 'Unexpected result or label: ' + item.id);
  for (const id of item.acceptanceIds ?? []) check(acceptanceIds.has(id), 'Unknown acceptance ID ' + id + ': ' + item.id);
  byCorpus[item.source.corpus] = (byCorpus[item.source.corpus] ?? 0) + 1;
  const events = item.input.history;
  check(events.length > 0 && new Set(events.map(event => event.id)).size === events.length, 'Empty history or duplicate event ID: ' + item.id);
  const eventIds = new Set(events.map(event => event.id));
  for (const event of events) {
    check(['user', 'agent', 'tool'].includes(event.role) && Number.isFinite(Date.parse(event.at)), 'Invalid role/time: ' + item.id);
    if (event.parentEventId) check(eventIds.has(event.parentEventId), 'Missing parent event: ' + item.id);
  }
}
check(byCorpus.general === 24 && byCorpus.agent === 12 && byCorpus.automatic === 12, 'Corpus proportions changed');
for (const key of Object.keys(byCorpus)) check(byCorpus[key] === manifest.counts.selectedByCorpus[key], 'Manifest corpus counts disagree: ' + key);
for (const family of new Set(materials.cases.filter(item => item.source.corpus === 'general').map(item => item.originalFamily))) {
  const pair = materials.cases.filter(item => item.source.corpus === 'general' && item.originalFamily === family);
  check(pair.length === 2 && new Set(pair.map(item => item.originalStratum)).size === 2, 'Missing semantic pair: ' + family);
}
for (const family of new Set(materials.cases.filter(item => item.source.corpus === 'automatic').map(item => item.originalFamily))) {
  const pair = materials.cases.filter(item => item.source.corpus === 'automatic' && item.originalFamily === family);
  check(pair.length === 2 && new Set(pair.map(item => item.language)).size === 2 && new Set(pair.map(item => item.family)).size === 1, 'Missing bilingual pair: ' + family);
}
check(selections.purpose === 'material_selection_only', 'Selection incorrectly promoted to evaluation');
check(selections.selections.length === 2 && new Set(selections.selections.map(item => item.id)).size === 2, 'Unexpected selection configuration');
for (const selection of selections.selections) {
  const expected = { 'smoke-16': 16, 'development-48': 48 }[selection.id];
  check(selection.caseIds.length === expected && new Set(selection.caseIds).size === expected, 'Invalid selection count: ' + selection.id);
  for (const id of selection.caseIds) check(materials.cases.some(item => item.id === id), 'Unknown selected case: ' + id);
}
console.log(JSON.stringify({ status: errors.length ? 'failed' : 'passed', windows: materials.cases.length, sourceEntries: manifest.inventory.length,
  selections: selections.selections.map(item => ({ id: item.id, windows: item.caseIds.length })), errors,
  limitations: 'Material integrity only. No model, task, oracle or product quality was evaluated.' }, null, 2));
process.exitCode = errors.length ? 1 : 0;
