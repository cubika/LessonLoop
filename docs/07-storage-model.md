# 存储数据模型

日期：2026-09-14。状态：持久数据合同与待实现的引擎映射。本文维护字段、容量、来源指纹和保留期限；领域判断见[经验模型](02-experience-model.md)，请求响应见[接口合同](04-contracts-and-extensions.md)。

产品对象与后端物理对象分开。Mem0/Qdrant 原型代码已删除，专用映射见[历史设计](research/2026-09-13-p0/mem0-architecture.md)；Hindsight 接入和 engine_binding 尚未实现。正常升级不清 DataRoot，程序回滚不能回滚删除与停用意图，路径行为见[发布与安装](10-distribution-and-installation.md)。

## 经验、来源和运行状态

LessonLoop 保存对外发布的经验、来源线索和必要控制状态。引擎管理原生事实、索引及归纳；这些内部产物通过映射参与准入，不直接成为可采用经验。

| 对象 | 逻辑记录 | 保存内容 | 生命周期 |
|---|---|---|---|
| Experience | 发布经验 | 当前结论、适用边界、分类、少量 evidence、推导引用 | 修改递增 revision；停用保留；删除清理 |
| EngineBinding | engine_binding，待实现 | 产品经验与引擎实例、原生产物及依据关系的映射 | 重处理后核对，不能借新原生 ID 绕过用户意图 |
| ScopeDefinition | scope_config | 集合名称、所有者、可信适配授权与默认映射 | 用户配置，模型不可修改 |
| LearningJob | learning_job | 脱敏 Material、阶段、结果 id/revision、纠正目标与已确认暂停事实、有限原因 | 短期保存；不建立永久通知或投递历史 |
| WriteOperation | write_operation | 未确认操作、目标身份、暂存待写内容 | 完成确认后清理，uncertain 保留到修复 |
| 来源控制标记 | delete_marker | 目标 ID/指纹、reason 与处理动作 | 区分忘记、擦除、撤回与版本替代，临时失效不等于永久删除 |
| ExtensionCheckpoint | extension_state | 代理适配私有的有限原生状态 | 按适配政策更新，不进入召回 |
| Connection 配置/状态 | connection_config / connection_state | 来源实例、计划、确认游标、接收与学习进度 | 用户配置，暂停/移除遵守同步合同 |
| SourceBinding | source_binding | 每连接+源对象的 current/pending 修订、指纹和任务绑定 | 有限当前同步映射，不保存完整源历史 |

管理对象按 recordType 区分，不参与语义召回。实际存储映射由适配实现验证；凭据存入系统凭据设施。

不永久保存完整邮件、完整会话、工具输出日志、每次投递记录、模型推理过程、逐级经验晋升链或完整修订历史。来源原件由外部系统保存，inspect 不会自动联网读取。

`scopeId` 表示归属与授权，适用条件另行保存。集合没有固定的 repo/branch 树；跨集合发布及使用规则见[领域模型](02-experience-model.md#核实结果的两条去向)。

## Experience 字段契约

容量按 UTF-8 字节计算。除来源非空要求外，必填数组可为空。ID、时间和状态由服务设置，模型只提出内容 proposal。下列限额是产品预算，不是数据库技术上限。

| 字段 | 类型与必选性 | 容量/规则 | 写入者 |
|---|---|---|---|
| id | string，必填 | 稳定产品 ID，最大 128 B；后端原生 ID 在映射中保存 | 服务 |
| revision | integer，必填 | 从 1 递增；正安全整数 | 服务 |
| scopeId | string，必填 | 最大 128 B，引用可访问 ScopeDefinition | 服务 |
| conclusion | string，必填 | 最大 2 KiB，一个主要主张 | 提炼器，经校验 |
| level | L1/L2/L3/L4/L5，必填 | 一个值，不决定可信程度 | 提炼器，经校验 |
| purpose | fact/constraint/lesson/procedure/rationale，必填 | 一个值；constraint 专指真实用户本人偏好/有权设置的规范 | 提炼器建议，服务核验 |
| applicability | general/conditional/unknown，必填 | 持久规则边界：general 无额外条件；conditional 有明确边界；unknown 不进入自动 guidance/lead | 服务依据提取结果设定 |
| conditions | Condition[]，必填 | 最多 4 条，每条 text 最大 512 B | 提炼器，经校验 |
| exceptions | Condition[]，必填 | 最多 4 条，每条 text 最大 512 B | 提炼器，经校验 |
| topics | string[]，必填 | 最多 8 项，每项 64 B，规范化主题 | 提炼器，经校验 |
| entities | string[]，必填 | 最多 16 项，每项 128 B，精确完整值 | 提炼器，经校验 |
| basis | reported/observed/inferred，必填 | 表示归属/观察/推断 | 服务依据可信通道 |
| assessment | attributed/supported/hypothesis/contested，必填 | 表示证据判定，不是概率 | 策略或明确用户操作 |
| evidence | Evidence[]，必填 | 典型 1–2 项，最多 3 项，整个数组最大 2 KiB | 服务绑定原文 |
| derivedFrom | {id, revision}[]，必填 | 最多 8 项，同 scope；禁止自支持/循环 | 服务验证 |
| sourceFingerprints | string[]，必填 | 最多 32 项，SHA-256 小写 hex 去重排序 | 服务计算直接与父记录根来源并集 |
| state | active/held/disabled，必填 | 使用状态；active 仅允许准入表的合法组合 | 服务/用户 |
| review | object，held 时必填 | 最大 1 KiB；reason、question、reviewBy，active 清除，disabled 可保留原因 | 服务依据缺口/明确保留意图 |
| createdAt, updatedAt | UTC 时间字符串，必填 | RFC 3339，最大 32 B/项 | 服务 |
| validFrom, validUntil | UTC 时间字符串，可选 | 省略表示该方向不设边界；区间必须有序 | 策略/用户，经校验 |

领域内容或使用边界改变都会递增 revision，evidence 和适用性也包含在内。sourceFingerprints 取直接 evidence 指纹与 derivedFrom 父经验根指纹的并集，数量不等于独立支持数。超过 32 项须缩小主张或暂缓整理，不得截断后继续使用。产品 ID 与后端引用通过下文 engine_binding 关联。

可持久化经验要求 evidence 与 derivedFrom 至少一者非空。纯派生记录可以 evidence=[]，不复制父经验的摘录；直接提供的原则保留其来源摘录。支持来源无法保持时，该 proposal 不作为 active 经验写入。

## 准入与复评字段约束

状态组合须通过[领域准入矩阵](02-experience-model.md#价值筛选与可执行判定)，不能只检查枚举合法。外部草稿不提供受信状态、角色或验证结果。

review.reason 取 verification_requested/conflict/source_changed/scope_unclear。question 用 1–512 B 写明待核实的问题，reviewBy 为 UTC 时间；整个 review 最多 1 KiB，计入 Experience 的 16 KiB 上限。question 只供阅读，不是命令。held 必须带 review，active 必须清除它；disabled 可保留已结束计划，说明停用原因。

复评默认期限为本轮进入 held 后 30 天，用户可以显式另设期限。reviewBy 与经验有效期 validUntil 独立，状态转换与防止无效续期的规则统一见[暂缓与复评](02-experience-model.md#暂缓复评与停止使用)。

## 可判断的适用条件

Condition 使用 `{text, match?}`。text 必填，写明完整条件；可选 match 为 `{key, values}`，只支持 one_of。key 最多 64 B，values 为 1–4 个字符串，每值最多 128 B。核心不实现任意规则 DSL、正则、版本表达式或路径前缀匹配。

key 使用命名空间，例如 `code.repo`、`code.branch`、`runtime.os`、`task.kind`、`document.kind`、`business.customer`。它们描述上下文，不授予权限。核心比较规范化后的精确值或集合交集，缺值为 unknown。分支条件必须同时限定 repo，以免同名分支串配。路径和复杂版本交给适配评估器，字符串前缀不能当作目录关系。

conditions 之间为 AND，exceptions 任一成立即排除；已知不满足或命中例外优先于其他未知项。返回用途与核实协议见[查询与结果](04-contracts-and-extensions.md#查询与结果)。

match 必须完整表达对应 text，否则拆成结构化条件和自由文本条件。单条判断返回 match/no_match/unknown。自由文本评估器只能使用本次真实上下文或短 contextEvidence，并说明依据；不执行来源指令，不猜缺失值。没有评估器或无法确认时为 unknown，没有具体可回答的问题时也不返回 lead。

## Evidence 与来源指纹

Evidence 必填 `excerpt`、`role`、`relation`、`fingerprint`，可选 `locator`、`author`、`observedAt`。role 取 user/agent/external/tool，relation 取 supports/contradicts。单项限制为 excerpt 512 B、locator 256 B、author 128 B、observedAt 32 B；所有条目的完整 JSON 合计最多 2 KiB。

excerpt 必须是脱敏输入中的连续原文，通常保留一句足以支持或反驳主张的话。不另存模型 evidence summary，不把改写当原文。

服务在材料持久化前生成 fingerprint：正文先脱敏、Unicode NFC 规范化、换行统一 LF，保留大小写及其余空白。按下列有序字段的 UTF-8 字节长度分隔编码计算 SHA-256，保存为小写 hex：

| 材料来源 | 有序输入 |
|---|---|
| 手动材料 | scopeId、完整规范化片段正文 |
| Connector | scopeId、服务确定的 bindingId、sourceRevision、partKey、完整规范化片段正文 |

长度前缀的具体字节格式须由实现固定并用跨重启测试校验，不能依赖字符串拼接分隔符。经验与作业沿用同一指纹；派生经验继承根指纹，不对短摘录或摘要重新计算。Connector 的绑定和版本规则见[源对象身份](08-connectors.md#源对象身份与经验来源)，原生对象键和账号细节不进入 Experience。

Evidence 默认不生成 embedding，也不随自动上下文返回，用户通过 inspect 查看原文、归属和位置。较长论证按需展开父经验引用，不向每条高层经验复制完整资料。

提取器须选择足够支持主张的短原文，必要时缩小或拆分主张。预算放不下时，返回需要更聚焦材料的原因，不能删掉影响含义的限定词或反例后仍沿用 supported。有效摘录可以没有 URL；有 URL 也不证明已经读过内容。

## 材料与派生产物保留

| 内容 | 保留与清理合同 |
|---|---|
| 已完成 LearningJob 的完整脱敏材料、短期 proposal 与结果 | 默认完成后 7 天清理；不建立永久候选库或通知历史 |
| 明确失败作业的材料 | 最多 30 天；到期前保留可定位来源的失败状态，界面不能显示已学会 |
| 已接收未完成材料、uncertain 所需材料与拟写内容 | 不套用完成清理期限；保留到确认完成或修复，避免丢失恢复依据 |
| 当前 Experience | 长期保留主张、短摘录和引用；停用仍可查看，用户删除按清理合同处理 |
| 来源控制与引擎映射 | 有引用、可能重放或需维持删除/停用意图时保留；不得随普通作业到期清理 |

Hindsight 的 document/chunks、原生事实、observations 和其他派生产物是独立副本。接入前须逐类核对默认保留、删除 API、来源传播及重处理行为，验证短期材料到期后哪些内容仍存储。不能只清理 LessonLoop 作业就宣称全文已删除，也不能为满足期限删除支撑仍有效经验的依据。

若引擎必须保留全文才能维持有效经验，须明确形成产品保留策略及用户可见设置后验收；当前不承诺 Hindsight 已满足上述短期全文策略。显式 erase 检查所有受控副本和派生结果，withdraw 只取消对应来源支持；重启和重处理不得恢复已撤回或遗忘的资格。

## 产品经验与引擎映射

`engine_binding` 是待实现的内部产品记录，不向普通客户端暴露，不复制原生产物全文。它维护已发布 Experience 与厂商产物的对应关系；具体持久后端和原生引用编码由适配器实现后验证。

| 字段 | 必须表达的内容 |
|---|---|
| experienceId / experienceRevision / scopeId | 当前产品经验与授权归属；产品 ID 不由厂商重处理重新分配 |
| backendInstanceId / engineType / processingConfigVersion | 实际引擎实例、种类和生效处理配置；旧实例回调不能修改新实例绑定 |
| nativeRefs | 原生产物 ID 与类型、命名空间、可核对的原生修订或内容摘要；允许拆分/合并造成多项映射 |
| sourceRefs / dependencyCoverage | 已知来源身份与修订、父产物关系及完整性；不能把几条引用当作完整依赖 |
| checkState / checkedAt | 最近核对是否可用、已变化、不可用或尚未确认及时间；不替代实时资格检查 |

原生产物变化后先阻断受影响建议，再重新准入并更新领域 revision。无法确定新产物是否继承用户停用/忘记意图时保持暂停。内容、来源及限制未变的索引重建不自动增加领域 revision。

映射的字段枚举、数量/字节上限、分页和原子更新方式仍待适配实现冻结并测试；在依赖覆盖和当前性无法核实时不得发布 guidance/lead。历史原型结果不能替代这项验收。

各适配器须声明检索、索引和完成确认的实际能力，并分别测试容量。Mem0 的索引投影及检索文本/payload 旧预算只保留在[历史映射](research/2026-09-13-p0/mem0-architecture.md#历史索引映射与专用预算)，厂商字段不进入公开 API。

## 总大小与超限处理

| 预算 | 首版硬上限 | 含义 |
|---|---|---|
| 应用 Experience JSON | 16 KiB | UTF-8 紧凑序列化完整对象，包含 evidence/关系/元数据；不是磁盘占用 |
| evidence 完整数组 | 2 KiB，最多 3 项 | 已包含在 16 KiB 内 |
| Material 输入 | 32 KiB | 脱敏后的完整请求 JSON，包含最多 16 个 segments 及上下文 |
| 自动召回输出 | 见[查询与结果](04-contracts-and-extensions.md#查询与结果) | 瞬时响应预算，不计入持久存储 |

表中是产品预算。中文字符通常占多个 UTF-8 字节，byte、字符和 token 不能互换；各项限额须同时满足，不能把字段最大值相加当成单条容量。后端原生记录、索引及模型 token 容量待适配器分别测量，不继承历史 Mem0 的 4/32 KiB 限额。

各后端按实际检索路径验证写入与可查询事实，不能把引擎仅接收任务当成已可检索。

单向量的原始存储量还与维度和数据类型有关，例如 float32 数值部分为维度乘 4 字节；索引、引擎字段和存储开销另计。容量验收须测真实存储增长，产品 JSON 上限不代表物理记录大小。

领域记录超限在调用后端前返回 record_too_large、evidence_too_large 或 input_too_large。适配器声明并检查额外容量与模型 token 限制。模型可重新提炼更小的独立主张；无法完整表达时保留失败原因，不截断后发布。

## 管理记录的最小合同

Material 必填 scopeId 和 segments，可选 verificationFor={id,revision} 用于主张补证。目标须在同 scope、调用方授权内且修订明确；该字段最多 256 B，计入材料的 32 KiB 总预算。它不授予执行权、observed 或 supported 身份，目标已变时也不自动解除新版 held。当次适用性核实走 recall.target/contextEvidence，不自动保存为 Material 或支持来源。

segments 为 1–16 项，每项包含非空 text 和声明的 role，可选 locator、author、observedAt，来源字段沿用 Evidence 的长度限制。context 可包含最多 32 个命名空间 key，每值为字符串或最多 4 项字符串数组；key 最多 64 B，值最多 128 B。整个脱敏请求合计最多 32 KiB。

服务校验可信通道角色、规范化文本并生成片段 fingerprint 后写入 LearningJob；模型不得提供这些权威字段。context 仅辅助提炼与当前查询，不自动全部复制进 Experience；只有确实影响适用性的限制转入 conditions/exceptions。

管理对象由服务生成稳定 ID，重试沿用同一操作身份。共享字段为 recordType、ownerId、createdAt、updatedAt、可选 scopeId；模型不能设置这些字段。下表维护产品记录预算，物理映射与写入确认由实际后端验证。

| recordType | 必需内容 | 容量与清理 |
|---|---|---|
| scope_config | scopeId、name、allowedAdapters、绑定的默认消费集合 | 8 KiB；名称 128 B，映射最多 32 项；用户配置长期保存 |
| learning_job | scopeId、material、stage、status、results、attempts；admissionDecisions、可选 correction/复评目标/触发原因 | 64 KiB；每作业最多8条 proposal，results/决策最多8项；清理按材料保留表 |
| write_operation | scopeId、operation、nonce、status；add/update/disable 的拟写内容；非 add 的 targetId/expectedRevision；作业来源的 jobId/itemIndex | 48 KiB；一个操作针对一条经验，写入和所属作业进度均确认后清理 |
| delete_marker | scopeId、target(id 或 fingerprint)、status、reason、action；Connector 来源另含 bindingId | 2 KiB；区分忘记/替代/撤回/擦除，保留源归属供整对象清理，不含正文 |
| extension_state | adapterId、key、代理私有 state | 8 KiB/项；不保存正文或凭据 |
| connection_config | Connector 类型/版本、transformRevision、目标 scope、来源筛选、计划、删除政策、凭据引用 | 16 KiB，秘密只保存引用 |
| connection_state | 已确认 cursor、当前运行、重试时间、接收/学习计数、连接与来源使用状态 | 16 KiB；cursor 最大 8 KiB，不保存正文 |
| source_binding | connectionId+sourceKey、内容摘要、sourceRevision、current/pending 指纹与 job 映射、excluded | 32 KiB；仅两份修订元信息，每份最多 8 个作业、128 个片段指纹；不存源正文或事件历史 |
| engine_binding，待实现 | 产品经验修订、引擎实例、原生产物与依据映射 | 字段见上文；容量与后端更新合同待实现冻结 |

引擎可能在生成 Experience 前就接受异步处理，不能只靠发布后的 engine_binding 恢复。LearningJob 须持久绑定 engineOperation/sourceJob：稳定产品作业身份、backendInstanceId、来源绑定与来源/处理配置修订、provider operation ID（无法确认时明确为 unknown），以及实际处理阶段和最近核对状态。提交前先保存关联身份；请求超时或重启后，先向原实例核对已有操作，不能直接重提材料。缺少可核对身份且无法确认结果时保留 uncertain。字段形状、阶段枚举、容量和后端更新方式待实现冻结，沿用产品管理存储，不增加独立数据库。

短期 admissionDecision 最多 1 KiB，包含 intent（temporary/normative/factual/causal/mixed）、persistence（task/window/durable/unclear）、futureUse（一句话，最多 256 B）、newValue/scopeComplete/supportAdequate（pass/fail/unknown）、disposition（reject/merge/retain_active/retain_held）及 reason（最多 256 B）。

服务校验模型提案，保留意图须来自用户实际输入，不能由模型自报授权。该记录只解释本次为何保存或拒绝，不作经验置信分或永久审计日志。

admissionDecision 的合法组合按[价值筛选矩阵](02-experience-model.md#价值筛选与可执行判定)验证；这里的字段记录判定结果，不另定义准入策略。

learning_job 保存材料和进度，不长期复制 8 份完整 proposal。逐条建立 write_operation，结果统一写为 results: {id,revision}[]，不另存重复 resultIds。

纠正可带 correction: {target?:{id,revision}, pauseConfirmed?:{id,revision}}。服务确认暂停后才写 pauseConfirmed，它记录已完成的事实，不能代替当前有效性检查。作业状态取 queued/running/completed/failed/uncertain，错误信息最多 512 B，不保存原始模型响应。明确失败的材料按期清理，uncertain 所需内容保留至修复完成。

stage 使用 extract/assess/consolidate/write，assess 表示准入或复评；write_operation.operation 为 add/update/disable/delete，状态为 prepared/uncertain/confirmed。add/update/disable 保存完整拟写经验或精确待写 payload，用于核对目标修订；delete 只需要目标。

Connector 来源的 LearningJob 另有 bindingId、sourceRevision、partKey，服务以它们确定稳定接收身份，写入前验证来源仍有效。一份源对象修订最多 8 个材料作业，每作业仍最多 8 条 proposal。

sourceKey 原值最多 512 B，超限时 Connector 提供稳定可逆定位或声明不支持，不静默截断。bindingId 使用服务确定性映射。同步来源的 bindingId/sourceRevision/partKey 必填，原生版本顺序及绑定清理条件见[同步生命周期](08-connectors.md)。

学习作业产生的 write_operation 必须带 jobId 和 itemIndex（0–7）。管理记录 ID 按这组值稳定生成，或由作业预先绑定。写确认后，先持久化 job 的已完成项、产品结果 id/revision 和已确认暂停事实，再清理操作；任何结果未确认时都保留操作。重启先核对已有绑定，不为同一条目重新提取并 add。这些关联只留在短期管理对象中。

ScopeDefinition 的 allowedAdapters 和默认集合映射仅由已认证用户配置，任务中的 scopeId 不能给适配器新增授权。

后端须证明管理记录与经验写入的确认和恢复行为，幂等身份本身不能解决迟到更新。运行时队列容量和每日模型预算可配置，满载返回 backpressure，不丢弃已确认接收的材料。

receipt 不另设持久表，按作业、写操作与当前经验生成；响应字段和展示时机统一见[纠正回执](04-contracts-and-extensions.md#纠正回执与展示时机)。

## 示例

下面用一条用户明确采用的工程约束说明字段。它归属工作集合，可以跨仓库使用，身份是 reported/attributed 的本人要求。如果原话是在转述客观结论，则须改用相应 purpose，并按证据判断能否 active，不能从用户原话推导出普遍因果结论。

```json
{
  "id": "example-memory-id",
  "revision": 1,
  "scopeId": "work:engineering",
  "conclusion": "Change the generation source when modifying generated output.",
  "level": "L4",
  "purpose": "constraint",
  "applicability": "conditional",
  "conditions": [
    {
      "text": "The target is a generated artifact.",
      "match": {"key": "artifact.kind", "values": ["generated"]}
    }
  ],
  "exceptions": [
    {
      "text": "The target is explicitly maintained by hand.",
      "match": {"key": "artifact.kind", "values": ["handwritten"]}
    }
  ],
  "topics": ["code-generation"],
  "entities": [],
  "basis": "reported",
  "assessment": "attributed",
  "evidence": [
    {
      "excerpt": "For my projects, always change the generation source for generated output; maintain handwritten files directly.",
      "role": "user",
      "relation": "supports",
      "fingerprint": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ],
  "derivedFrom": [],
  "sourceFingerprints": ["0000000000000000000000000000000000000000000000000000000000000000"],
  "state": "active",
  "createdAt": "2026-09-13T00:00:00Z",
  "updatedAt": "2026-09-13T00:00:00Z"
}
```

真实 fingerprint 由服务对脱敏片段计算，示例零值不用于生产写入。若本次 artifact.kind 缺失，taskApplicability=undetermined，持久 applicability 仍为 conditional；合格且启用线索时可返回 lead，不能因结论合理就猜测文件是否生成。
