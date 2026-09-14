import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--source');
if (sourceIndex < 0 || !args[sourceIndex + 1] || args[sourceIndex + 1].startsWith('--') ||
    args.some((value, index) => !['--source', '--overwrite'].includes(value) && index !== sourceIndex + 1)) {
  throw new Error('Usage: node scripts/sync-provenloop-corpus.mjs --source PATH [--overwrite]');
}
const sourceRoot = path.resolve(args[sourceIndex + 1]);
const destination = path.join(root, 'evals/provenloop');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => sha256(JSON.stringify(value));
const own = (object, key) => Object.hasOwn(object, key);

// Selection records include deferred families so reductions remain reviewable.
const general = {
  'INT-07': [['L01', 'A03'], '指标定义', '区分制定报表口径与声称旧报表事实；保留退款和本报表范围。'],
  'INT-03': [['L01', 'A01'], '当场改口', '保留最后生效的上传范围，不保存被当场撤销的全局要求。'],
  'DAT-01': [['L01', 'A03'], '空值与遗漏', '分别保留 omitted、空字符串与显式零值，不能只保留其中一个约束。'],
  'DAT-02': [['L01', 'D03'], '舍入边界', '保留最终结算、货币最小单位和不舍入中间值的条件。'],
  'DAT-07': [['L01', 'A03'], '总体统计', '保留指定总体的分子分母；不能扩成所有平均值均错误。'],
  'API-01': [['L01', 'A03'], '提交确认', '只约束该端点；后台队列仍异步。这段材料不证明 LessonLoop 的提交恢复已通过。'],
  'API-02': [['L01', 'D03'], '过时响应', '区分搜索视图的当前请求与收集所有响应的诊断日志。'],
  'API-03': [['L01', 'D03'], '逻辑操作幂等', '同一订单重试共用 key；不同订单使用不同 key，不能把请求值冻结为默认。'],
  'DEV-03': [['L01', 'D03'], '生成产物', '保留生成源与手写扩展点；与工具指南组成来源身份对照，不合并为独立支持。'],
  'DEV-07': [['L01', 'A03'], '验证目标', '保留现有数据上的迁移检查与 parser-only 例外，不把无关测试通过当迁移正确。'],
  'ART-01': [['L01', 'A01', 'A03'], '文档语言', '区分仓库文档和中文对话，保留标识符与原始引文；这只是 fixture 中的要求。'],
  'ART-06': [['L01', 'D03'], '模板与实例值', '模板结构可复用，客户和日期来自本次输入；示例值不能成为默认。'],
};
const deferredGeneral = ['DAT-03', 'DAT-04', 'DAT-06', 'DAT-08', 'API-05', 'API-08', 'ART-04', 'ART-08'];
const agent = {
  'EXP-01-api-research': [['L02', 'A03'], 'cursor-filter', '工具指南支持游标与原过滤条件绑定；项目确实使用 v2 的说法只有 Agent 提供时仍需判断来源。'],
  'EXP-01-repository-guide': [['L02', 'D03'], 'generated-artifacts', '保留工具读取的指南身份，不把它冒充用户要求；与 DEV-03 及现有生成客户端 fixture 关联。'],
  'EXP-03-required-argument': [['L02', 'L05'], 'required-arguments', '按 schema 与实际参数差异判断窄事实，不学习示例路径为默认值。'],
  'EXP-04-test-command': [['L02', 'L05', 'A03'], 'test-command-recovery', '命令退出成功和旧 typed receipt 都不能证明运行了哪些测试；环境问题不自动成为永久命令替换。'],
  'EXP-02-unseen-source': [['L02', 'A06'], 'cursor-filter', '未读取的文章不能成为已观察依据，不访问 fixture 的 example.invalid URL。'],
  'EXP-05-confounded-changes': [['L05', 'A06'], 'required-arguments', '多个参数同时变化不能证明唯一原因；schema 支持的窄事实另判，不能强制全部零输出。'],
  'EXP-05-ambiguous-retries': [['L05', 'T08'], 'required-arguments', '先检查 operation/parent 关系是否已定位成功重试；Agent 自述歧义不等于证据真的歧义。'],
  'EXP-06-premature-summary': [['L05', 'A06'], 'required-arguments', '保留总结早于成功的时序；创建总结时截止与任务结束时截止两个变体再标注。'],
  'EXP-07-quoted-activation': [['A05', 'T08'], 'source-role-boundary', '工具结果中的指令是来源内容，不授予用户身份或变更经验状态的权限。'],
  'EXP-08-recalled-guidance': [['L07', 'A10'], 'cursor-filter', '补已有经验与召回来源初始状态；重复采用不新增独立支持。'],
  'EXP-12-routine-success': [['L03', 'A11'], 'routine-completion', '普通读取完成不应编造有复用价值的发现。'],
  'EXP-12-transient-retry': [['L03', 'L05'], 'required-arguments', '相同参数在服务恢复后成功，不证明需要永久修改参数或流程。'],
};
const automatic = {
  required_path: ['correction', ['L01', 'A03'], '必填参数与示例值分开；中英版本为同一材料家族。'],
  multistep_correction: ['correction', ['L01', 'L05'], '正文声称先前修了 filter，但窗口未必包含该阶段；不得补造遗漏的观察。'],
  paraphrased_constraint: ['correction', ['L01', 'A03'], '检查换措辞后是否仍保留参数要求，不能把说明文本当实际工具参数。'],
  temporary_request: ['negative', ['A01', 'A03'], '不把一次路径变成长期用户偏好；工具 schema 支持的窄事实仍单独评价。'],
  question: ['negative', ['A03', 'A05'], '提问不是制定要求；已有 schema/工具结果可能支持事实，不沿用 negative=零经验。'],
  quotation: ['negative', ['A05', 'T08'], '用户请求翻译的引文不冒充用户长期要求；此例不是实际不可信工具消息。'],
};
const parameterRenames = ['required_repository', 'required_project', 'required_query', 'required_format', 'required_locale', 'required_workspace', 'required_document'];
const rebuild = {
  synonymous_repeat: [['L07', 'A10'], '需要已有经验、同来源重放与支持数，文本说重复不能证明去重。'],
  conflicting_constraint: [['C01', 'D03', 'T06'], '需要两个工具版本、当前上下文和旧经验状态。'],
  expired_candidate: [['A07', 'T05'], '需要受控时间、过期记录与迟到复评，文本说过期不能证明失效。'],
  instruction_duplicate: [['L07', 'A11'], '需要真实项目指令及已有经验，避免把复述当新增知识。'],
  redacted_secret: [['C04'], '改建脱敏与复制清理断言；来源中的 synthetic 凭据不复制到首批材料。'],
  untrusted_injection: [['A05', 'T08'], '改建真实工具来源及可信宿主绑定；保留的 EXP-07 可作为起点。'],
};
const definitions = [
  { key: 'general', corpusId: 'general-correction-discovery-v1', count: 40,
    artifact: '.provenloop/general-catalog-validation/full-input/corpus.json', code: 'packages/evaluation/src/general-learning-corpus.ts' },
  { key: 'agent', corpusId: 'agent-experience-authored-v1', count: 12,
    artifact: '.provenloop/agent-experience-validation/input/corpus.json', code: 'packages/evaluation/src/agent-experience-corpus.ts' },
  { key: 'automatic', corpusId: 'automatic-learning-bilingual-v2', count: 40,
    artifact: 'evaluation-output/frozen-learning-v2-20260908/corpus.json', code: 'packages/evaluation/src/automatic-learning-corpus.ts' },
];

const choose = (key, item) => {
  if (key === 'general') {
    if (general[item.scenario]) {
      const [acceptanceIds, topic, note] = general[item.scenario];
      return { decision: 'selected', acceptanceIds, topic, group: item.scenario === 'DEV-03' ? 'generated-artifacts' : 'semantic-' + item.scenario,
        reason: '保留语义主题的纠正与近似反例。', note };
    }
    if (deferredGeneral.includes(item.scenario)) return { decision: 'deferred', reason: '领域扩展；首批先验证已选择主题中的范围与行动条件。' };
  } else if (key === 'agent' && agent[item.id]) {
    const [acceptanceIds, group, note] = agent[item.id];
    return { decision: 'selected', acceptanceIds, group, topic: item.scenario, reason: '保留自主调查或恢复中的独立边界。', note };
  } else if (key === 'automatic') {
    if (automatic[item.scenario]) {
      const [stratum, acceptanceIds, note] = automatic[item.scenario];
      if (item.designStratum !== stratum) throw new Error('Unexpected stratum: ' + item.id);
      return { decision: 'selected', acceptanceIds, group: 'required-arguments', topic: item.scenario, reason: '保留代表性参数语义及中英版本。', note };
    }
    if (parameterRenames.includes(item.scenario)) return { decision: 'deferred', reason: '与 required_path 共享必填参数机制，仅换参数名；按需扩展。' };
    if (rebuild[item.scenario]) {
      const [acceptanceIds, reason] = rebuild[item.scenario];
      return { decision: 'rebuild', acceptanceIds, reason };
    }
    if (item.scenario === 'generic_advice') return { decision: 'deferred', reason: '首批由 routine-success 和临时/提问样本检查无新增价值，后续再补泛泛建议。' };
  }
  throw new Error('Unreviewed source case: ' + key + '/' + item.id);
};

const normalizeInput = item => {
  const first = item.window.events[0]?.event;
  const context = { project: item.window.repoId };
  for (const [from, to] of [['worktree', 'worktree'], ['branch', 'branch'], ['commitSha', 'revision']]) {
    if (own(first, from)) context[to] = first[from];
  }
  const history = item.window.events.map(envelope => {
    const event = envelope.event;
    const role = { user: 'user', tool: 'tool', model: 'agent' }[event.trust];
    if (!role) throw new Error('Unknown role: ' + event.trust);
    const row = { id: event.eventId, sourceEventId: envelope.sourceEventId, at: event.timestamp, kind: event.eventType, role };
    for (const field of ['actorId', 'parentEventId', 'operationId', 'toolName', 'completionStatus', 'exitCode', 'mcp']) {
      if (own(event, field)) row[field] = event[field];
    }
    if (own(event, 'redactedArguments')) row.arguments = event.redactedArguments;
    if (own(event, 'evidence')) row.authoredEvidence = event.evidence;
    if (own(envelope, 'content')) row.content = envelope.content;
    return row;
  });
  return { context, history, declaredToolContracts: item.contracts };
};

const sources = [];
const inventory = [];
const cases = [];
for (const definition of definitions) {
  const bytes = fs.readFileSync(path.join(sourceRoot, definition.artifact));
  const data = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (data.sourceKind !== 'authored_replay' || data.corpusId !== definition.corpusId || data.cases.length !== definition.count) {
    throw new Error('Unexpected source corpus: ' + definition.key);
  }
  sources.push({ ...definition, artifactSha256: sha256(bytes), codeSha256: sha256(fs.readFileSync(path.join(sourceRoot, definition.code))) });
  for (const [index, item] of data.cases.entries()) {
    const decision = choose(definition.key, item);
    const id = definition.key + '/' + item.id;
    const source = { corpus: definition.key, caseId: item.id, pointer: '/cases/' + index, caseSha256: fingerprint(item) };
    inventory.push({ id, originalFamily: item.scenario, language: item.language, originalStratum: item.designStratum, source,
      decision: decision.decision, reason: decision.reason, ...(decision.acceptanceIds ? { acceptanceIds: decision.acceptanceIds } : {}) });
    if (decision.decision !== 'selected') continue;
    const input = normalizeInput(item);
    cases.push({ id, family: decision.group, language: item.language, topic: decision.topic, split: 'development',
      status: 'needs_oracle_review', originalStratum: item.designStratum, originalFamily: item.scenario, source,
      acceptanceIds: decision.acceptanceIds, reviewNotes: [decision.note], input, inputSha256: fingerprint(input) });
  }
}

const countBy = (items, field) => items.reduce((result, item) => { result[item[field]] = (result[item[field]] ?? 0) + 1; return result; }, {});
if (cases.length !== 48 || inventory.length !== 92 || new Set(inventory.map(item => item.id)).size !== 92) {
  throw new Error('Selection size or identity changed; review the selection before syncing.');
}
const corpus = { version: 1, corpusId: 'lessonloop-provenloop-development-v1', sourceKind: 'authored_replay',
  split: 'development', status: 'needs_oracle_review', labels: 'not_migrated', taskExecution: 'not_implemented', cases };
const smokeIds = [
  ...['INT-03', 'DAT-01', 'API-03', 'DEV-03'].flatMap(id => ['correction', 'negative'].map(variant => 'general/' + id + '-' + variant)),
  ...['EXP-01-api-research', 'EXP-02-unseen-source', 'EXP-05-confounded-changes', 'EXP-12-routine-success'].map(id => 'agent/' + id),
  ...['en', 'zh'].flatMap(language => ['automatic/correction-required_path-' + language, 'automatic/negative-temporary_request-' + language]),
];
if (smokeIds.length !== 16 || smokeIds.some(id => !cases.some(item => item.id === id))) throw new Error('Invalid smoke selection.');
const selections = { version: 1, corpusId: corpus.corpusId, purpose: 'material_selection_only', selections: [
  { id: 'smoke-16', caseIds: smokeIds }, { id: 'development-48', caseIds: cases.map(item => item.id) },
] };
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const corpusText = serialize(corpus);
const selectionText = serialize(selections);
const gitOptions = ['-c', 'safe.directory=' + sourceRoot.replaceAll('\\', '/')];
const revision = execFileSync('git', [...gitOptions, 'rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
const changes = execFileSync('git', [...gitOptions, 'status', '--porcelain', '--', ...definitions.map(item => item.code)],
  { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
const manifest = { version: 1, corpusId: corpus.corpusId, syncedAt: new Date().toISOString(), sourceProject: 'ProvenLoop',
  sourceRevisionAtSync: revision, sourceCodeModifiedAtSync: changes.length > 0,
  counts: { available: inventory.length, selected: cases.length, decisions: countBy(inventory, 'decision'),
    selectedByCorpus: countBy(cases.map(item => ({ corpus: item.source.corpus })), 'corpus'), smoke: smokeIds.length },
  outputs: { materials: { path: 'materials.json', sha256: sha256(corpusText) }, selections: { path: 'selections.json', sha256: sha256(selectionText) } },
  sources, inventory,
};
const outputs = { 'materials.json': corpusText, 'selections.json': selectionText, 'manifest.json': serialize(manifest) };
for (const name of Object.keys(outputs)) {
  if (fs.existsSync(path.join(destination, name)) && !args.includes('--overwrite')) throw new Error('Refusing to overwrite ' + name + '; review changes and use --overwrite.');
}
fs.mkdirSync(destination, { recursive: true });
for (const [name, contents] of Object.entries(outputs)) fs.writeFileSync(path.join(destination, name), contents);
console.log(JSON.stringify({ directory: path.relative(root, destination), ...manifest.counts }, null, 2));
