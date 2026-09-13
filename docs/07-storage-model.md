# 存储数据模型

日期：2026-09-13。状态：首版设计契约，待 P0 实现验证。本文定义持久化对象、字段形状、检索用途与大小限制；经验层次和学习规则见[经验模型](02-experience-model.md)，组件与恢复流程见[架构](03-architecture.md)。

## 经验、来源和运行状态

数据层使用 Mem0 + Qdrant。长期保留的主体是一条可独立使用的经验，附少量来源线索；完整材料只用于短期学习，不变成永久的第二份内容库。

| 对象 | 保存位置 | 保存内容 | 生命周期 |
|---|---|---|---|
| Experience | Mem0 管理的经验 collection | 当前结论、适用边界、分类、少量 evidence、推导引用 | 修改递增 revision；停用保留；删除清理 |
| ScopeDefinition | 管理 collection，scope_config | 集合名称、所有者、可信适配授权与默认映射 | 用户配置，模型不可修改 |
| LearningJob | 管理 collection，learning_job | 脱敏 Material、阶段、结果 id/revision、纠正目标与已确认暂停事实、有限原因 | 短期保存；不建立永久通知或投递历史 |
| WriteOperation | 管理 collection，write_operation | 未确认操作、目标 ID/nonce、暂存待写内容 | 完成确认后清理，uncertain 保留到修复 |
| 来源控制标记 | 管理 collection，delete_marker | 目标 ID/指纹、reason 与处理动作 | 区分忘记、擦除、撤回与版本替代，临时失效不等于永久删除 |
| ExtensionCheckpoint | 管理 collection，extension_state | 代理适配私有的有限原生状态 | 按适配政策更新，不进入召回 |
| Connection 配置/状态 | 管理 collection，connection_config / connection_state | 来源实例、计划、确认游标、接收与学习进度 | 用户配置，暂停/移除遵守同步合同 |
| SourceBinding | 管理 collection，source_binding | 每连接+源对象的 current/pending 修订、指纹和任务绑定 | 有限当前同步映射，不保存完整源历史 |

Qdrant 仍只有一个应用经验 collection 和一个 `lessonloop_operations` 管理 collection。管理集合按 recordType 区分对象，不计算语义嵌入；Mem0 的内部辅助集合由 Mem0 管理。身份凭据放系统凭据设施，普通配置文件可保存连接参数，均不含第二份经验。

不永久保存完整邮件、完整会话、工具输出日志、每次投递记录、模型推理过程、逐级经验晋升链或完整修订历史。来源原件由外部系统保存，inspect 不会自动联网读取。

## 范围有两种不同含义

`scopeId` 表示知识归属和访问边界；`applicability`、`conditions` 和 `exceptions` 表示经验在什么情况下有用。二者不能合并成一个 repo/branch 层级。

| 例子 | 归属集合 scopeId | 适用性 |
|---|---|---|
| 个人写作偏好 | personal:writing | 无额外限制时 general；与代码仓库无关 |
| 有生成流程的客户端应修改生成源 | work:engineering | conditional，生成产物、生成方式及手写例外 |
| 某项目只用 pnpm 安装依赖 | work:project-a | conditional，可限定 code.repo；通常不限定 branch |
| 仅在一次迁移分支使用兼容步骤 | work:project-a | conditional，code.repo + code.branch + 有效期 |
| 某客户验收材料的要求 | work:client-a | conditional，业务任务/客户/材料类型 |
| 超时后重试外部写操作的风险 | work:engineering | conditional，外部副作用、幂等条件；可跨多个仓库 |

集合可以是个人资料、工作领域或具体项目，不内置 repository、branch、team 的固定树。初期单用户，集合仍限制不同扩展可访问的内容。general 只表示没有已知的额外适用限制，不代表对所有用户公开，也不代表原则已普遍证实。

采集时的 repo、branch、path 是来源上下文，只有当结论依赖它们时才进入条件。一次调查发生在某分支，不应把以后都成立的经验锁定到该分支。L1–L5、归属集合和适用范围相互独立：L1 可以跨项目有用，L5 也可以只适用于一种系统。

消费方只从其明确授权的集合检索。扩大适用条件不扩大访问权限；在更广集合发布经验必须由用户发起新 proposal，检查脱敏、来源与判定，不能删掉私有来源后原样继承 supported/active。首版 derivedFrom 仅允许同一 scope 内引用。

## Experience 字段契约

容量以 UTF-8 字节计。必填数组允许为空，除下文的来源非空约束。ID、时间和状态由服务设置，模型只提交可校验的内容 proposal。具体限额是产品预算，不是 Mem0/Qdrant 的最大能力。

| 字段 | 类型与必选性 | 容量/规则 | 写入者 |
|---|---|---|---|
| id | string，必填 | Mem0 ID，最大 128 B；不复制进 ll_record | Mem0 |
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

所有领域内容或使用边界的变化都递增 revision，包括 evidence 与适用性。sourceFingerprints 是直接 evidence 指纹及所有 derivedFrom 父经验根指纹的并集，不能用其数量当独立支持数；超过 32 项时不能截断后继续使用，须缩小主张或暂缓整理。

可持久化经验要求 evidence 与 derivedFrom 至少一者非空。纯派生记录可以 evidence=[]，不复制父经验的摘录；直接提供的原则保留其来源摘录。支持来源无法保持时，该 proposal 不作为 active 经验写入。

## 准入与复评字段约束

purpose 不新增分类树。constraint 表示真实用户为本人或有权管理范围设定的要求，涵盖长期偏好；外部规范的陈述通常是 fact/procedure，不能因命令式措辞转换成用户要求。详细例子以[准入规则](02-experience-model.md)为准。

active 的允许组合为：通过价值与证据检查的 supported；或 purpose=constraint、basis=reported、assessment=attributed 且保留对应真实用户声明。该身份和范围由服务核验，不能仅凭 JSON 中 role=user 决定。hypothesis/contested 不允许 active；归属明确但无事实支持的 attributed 客观断言也不允许 active。

review.reason 为 verification_requested/conflict/source_changed/scope_unclear；question 为 1–512 B 的具体缺口，reviewBy 为 UTC 时间，整个 review 最多 1 KiB并计入 Experience 16 KiB。question 是供检查者阅读的问题，不是命令。held 必须有 review，active 不允许残留 review；disabled 可保留已结束计划解释停用原因。

复评默认从进入本轮 held 起 30 天，用户显式设定的期限可以覆盖默认。新证据可提前重评；普通重试、浏览、重复输入或无关编辑不续期。到期 unresolved 转 disabled，停止自动复评而非自动删除正文；普通 Connector 同步不能重新启用。日期字段与状态变化都使用 expectedRevision，防止到期旧任务误停新修订。

reviewBy 与 validUntil 独立：前者是等待核实的期限，后者是结论适用的截止时间。未到 reviewBy 也不能自动使用 held；validUntil 到期的 active 也不能送入正常召回。期限到达不会变成支持证据。

## 可判断的适用条件

Condition 的形状是 `{text, match?}`。text 必填，说明完整条件；match 可选，形状为 `{key, values}`，语义固定为 one_of。key 最大 64 B，values 为 1–4 个字符串，每值最大 128 B。核心不提供任意规则 DSL、正则、版本表达式或路径前缀匹配。

可选 key 使用命名空间，例如 `code.repo`、`code.branch`、`runtime.os`、`task.kind`、`document.kind`、`business.customer`。这是上下文协议，不是权限模型。核心比较规范化精确值或集合交集；缺值就是 unknown。分支条件必须同时限定 repo，避免相同分支名在不同仓库串配。路径与复杂版本条件由适配评估器解释，不能把字符串前缀当成目录关系。

本次匹配先通过授权、active/准入合法、有效期、当前来源与依赖门槛。不同 conditions 为 AND，exceptions 任一成立就排除；已知条件不满足/例外命中优先于其他未知项。本次全部条件满足且例外均排除为 applicable/guidance；无明确冲突但缺可核实当前信息为 undetermined，只在显式启用且满足线索标准时 lead。持久 applicability=unknown 不能当作这种上下文缺失。

match 必须完整表达该条 text。表达不全时拆为结构化条件与自由文本条件；单条评估返回 match/no_match/unknown。自由文本评估器只能使用本次实际上下文或短 contextEvidence，说明判断依据；不能执行来源指令或猜缺失值。未配置或无法确认是 unknown；若没有具体可回答的核实问题，也不能为了给结果而包装成 lead。

来源上下文并非永远可信：code.repo 等由绑定宿主确定；contextEvidence.keys 只声称涉及哪些键，不能证明键值成立。服务核对真实归属、当前对象/版本/时间与材料关系，不接受自报 role=tool 获得观察身份。模型不能覆盖宿主值或通过 context 改写授权。

## 召回与核实的瞬时合同

这些字段只属于请求、响应或消费端任务缓存，不写入 Experience、Mem0 metadata 或 Qdrant 管理记录。现有持久 state/basis/assessment/applicability 不新增枚举。

| 字段 | 形状与初始限制 | 用途 |
|---|---|---|
| recall.includeLeads | boolean，可选，默认 false | 明确要求并能够处理待核实线索 |
| recall.target | 可选 {id, revision}，id≤128 B，正安全整数 | 精确重评当前项，不跳过 query/scope/context 与资格检查 |
| recall.context | 0–32 个命名空间 key；每 key≤64 B、每值≤128 B，可为最多4项数组 | 本次环境信息，与材料 context 形状相同，不授权 |
| recall.contextEvidence | 最多4项 {keys,excerpt,role,locator?}，keys 1–4 项，excerpt≤512 B、locator≤256 B | 请求内可核验短材料，沿用真实通道归属规则 |
| item.usage | guidance/lead，所有自动返回项必填 | 可采用经验或待核实线索 |
| item.taskApplicability | applicable/undetermined，返回项必填 | 本次适用性，not_applicable 只作内部判定/定向空结果原因 |
| item.relevanceReason | lead 必填，1–256 B | 说明任务与经验的具体关联，不使用相似分数代替 |
| item.missingChecks | lead 必填，1–4 项 {field,index,question,contextKey?} | field 为 conditions/exceptions，index 是目标修订数组下标；question≤256 B，不是命令 |

完整 recall 请求 JSON 最大 16 KiB，含 query（≤4 KiB）、scopeIds（最多8个，每个≤128 B）、context、contextEvidence 与其他参数。超过预算返回 request_too_large，不截断出处或把未核实值填成成立；原有 Material 32 KiB 和 Experience 16 KiB 预算独立。

所有 returned item 仍含结论、条件/例外、purpose/basis/assessment 和有效区间。lead 最多1项、missingChecks 最多4个；若未知项超过4个且不能保持完整性，暂不返回该线索，不遗漏未检查例外。两类合计≤3项/约800 token，guidance 优先；guidance 的 missingChecks 必须为空或省略。

缺口引用始终与 item.id/revision 一起解释。确认材料先转换成可信当前上下文，再定向 recall；结果不保存为支持来源、不改经验修订。当前自动资格（授权、state/依据、有效期、来源/依赖和屏障）失败或不存在时统一 target_unavailable；全部通过后修订不符才 target_changed。消费端丢弃旧检查项，有效性检查优先于披露变更。

每任务+经验 ID 的检查预算由客户端短期缓存维护，最多两轮、有新信息才继续，重排/换修订不重置；缓存丢失后不自动续查旧任务。检查计划、question 与返回结果都不构成执行授权。持续的新支持/反例才按 verificationFor 进入现有准入。

## Evidence 保持短小

Evidence 必填字段为 `excerpt`、`role`、`relation`、`fingerprint`；可选 `locator`、`author`、`observedAt`。role 为 user/agent/external/tool，relation 为 supports/contradicts。每个 excerpt 最大 512 B，locator 最大 256 B，author 最大 128 B，observedAt 最大 32 B。所有条目的完整 JSON 合计不超过 2 KiB，不是每项各有 2 KiB。

excerpt 必须是脱敏输入中的连续原文，通常保留一句足以支持或反驳主张的话。手动 fingerprint 按 scope+规范化完整片段计算；Connector 来源还绑定 bindingId/sourceRevision/partKey 以区分来源与修订，公式见[持续同步](08-connectors.md)。原生 ID 不进入经验。不另存模型 evidence summary，不把改写当原文。

Evidence 默认不进入 embedding，不随自动上下文返回。inspect 才展开原文、归属和可用位置。较长论证通过少量父经验引用按需展开；无需给每条高层经验复制一遍完整资料。

不能为了满足预算删除改变含义的限定词或反例。提取器应选择足够且短的原文，或缩小/拆分主张；确实放不下则返回需要更聚焦材料的原因。不得机械截断后沿用原 supported 判定。没有 URL 也可保存有效摘录，有 URL 不证明该内容已读。

## 搜索与索引映射

| 字段组 | 默认语义检索 | 显式查询/过滤 |
|---|---|---|
| conclusion、conditions.text、topics、entities | 组成 Mem0 memory 正向文本 | conclusion/conditions 指定 text 查询；topics/entities keyword |
| exceptions.text | 否 | browse(query, field=exceptions) 仅调查；recall 不接受该字段，自动召回仍检查例外 |
| scopeId、state、level、purpose、applicability、basis、assessment | 否 | Qdrant 精确过滤；scope 强制从身份解析 |
| review.reason、reviewBy | 否 | 详情/复评管理；reviewBy 数值投影用于有界到期扫描，不参与相关性 |
| createdAt、updatedAt、validFrom、validUntil | 否 | 数值时间投影和范围过滤 |
| evidence 原文、作者、来源位置 | 否 | 首版 inspect；不承诺任意正文/作者搜索 |
| sourceFingerprints、derivedFrom.id | 否 | Qdrant keyword 查来源副本和反向依赖 |
| id、revision | 否 | 精确读取/修订检查 |
| match.key/values | 否 | 在有限候选上判断；首版不自动为任意上下文 key 建索引 |

常用的扁平索引字段从 ll_record 机械生成：ll_scope、ll_state、ll_level、ll_purpose、ll_applicability、ll_basis、ll_assessment、ll_topics、ll_entities、ll_source_fingerprints、ll_parent_ids 与数值时间字段，包括可选 ll_review_by_ms。字段名是映射，不是独立当前数据。

不能因为当前任务有 repo 就加一个必须匹配 repo 的全局候选过滤，否则会丢掉未限定 repo 的通用经验。后续若把上下文条件移到前置筛选，须同时保留 general 与没有该维度限制的记录，验证嵌套 key/value 不串配。

## 总大小与超限处理

| 预算 | 首版硬上限 | 含义 |
|---|---|---|
| 应用 Experience JSON | 16 KiB | UTF-8 紧凑序列化完整对象，包含 evidence/关系/元数据；不是磁盘占用 |
| evidence 完整数组 | 2 KiB，最多 3 项 | 已包含在 16 KiB 内 |
| Mem0 memory 检索文本 | 4 KiB | 同时不得超过选定 embedding 模型的 token 限制 |
| 应用控制的持久 payload | 32 KiB | memory 文本、ll_record、索引投影和应用控制 metadata 合计；不含向量/引擎内部附加字段 |
| Material 输入 | 32 KiB | 脱敏后的完整请求 JSON，包含最多 16 个 segments 及上下文 |
| 自动召回输出 | 约 800 token，最多 3 条，其中最多 1 条 lead | guidance 优先，完整保留用途、边界与缺口；默认不含 evidence |

这些是本产品的初始预算，并非数据库最大记录限制。中文通常占多个 UTF-8 字节；byte、字符和 token 不能互换。完整 limits 必须同时满足，单字段允许的最大值不能简单相加当成一条记录的容量。

单向量的原始存储量还与维度和数据类型有关，例如 float32 向量的原始数值部分为维度乘 4 字节；索引、引擎字段和存储开销另计。P0 记录真实 payload 与磁盘增长，不用 16/32 KiB 宣称物理记录最大占用。

超限在调用 Mem0 前返回 record_too_large、evidence_too_large、search_text_too_large 或 input_too_large。token 超限同样拒绝，不用自动截断改变结论。模型可重新提炼更小的独立主张；无法在预算内完整表达则保留作业失败原因，不发布该经验。

## 管理记录的最小合同

Material 请求必填 scopeId 与 segments，可选 verificationFor={id,revision} 关联经验主张的补证目标。当次适用性核实走 recall.target/contextEvidence，不自动写入 Material 或支持来源。目标必须同 scope、在调用方授权内且修订明确；最大 256 B，计入 32 KiB 材料总预算。它不赋予执行权、不授予 observed 或 supported；目标已变时不自动解除新修订 held。segments 为 1–16 项，每项包含非空 text 与声明的 role，可选 locator、author、observedAt，来源字段沿用 Evidence 的长度限制。可选 context 是最多 32 个命名空间 key 的映射，每个值为字符串或最多 4 个字符串的数组；key 最大 64 B、值最大 128 B。整个脱敏请求仍须满足 32 KiB，而不是每个 text 各有 32 KiB。

服务校验可信通道角色、规范化文本并生成片段 fingerprint 后写入 LearningJob；模型不得提供这些权威字段。context 仅辅助提炼与当前查询，不自动全部复制进 Experience；只有确实影响适用性的限制转入 conditions/exceptions。

管理 point ID 是服务生成的稳定 UUID，重试使用同一个操作身份。共享字段为 recordType、ownerId、createdAt、updatedAt、可选 scopeId；模型不能设置这些字段。payload 按 recordType 校验，不放进 Mem0.add。

| recordType | 必需内容 | 容量与清理 |
|---|---|---|
| scope_config | scopeId、name、allowedAdapters、绑定的默认消费集合 | 8 KiB；名称 128 B，映射最多 32 项；用户配置长期保存 |
| learning_job | scopeId、material、stage、status、results、attempts；admissionDecisions、可选 correction/复评目标/触发原因 | 64 KiB；results/决策最多8项；完成内容与结果默认7天清理，确定失败最多30天 |
| write_operation | scopeId、operation、nonce、status；add/update/disable 的拟写内容；非 add 的 targetId/expectedRevision；作业来源的 jobId/itemIndex | 48 KiB；一个操作针对一条经验，写入和所属作业进度均确认后清理 |
| delete_marker | scopeId、target(id 或 fingerprint)、status、reason、action；Connector 来源另含 bindingId | 2 KiB；区分忘记/替代/撤回/擦除，保留源归属供整对象清理，不含正文 |
| extension_state | adapterId、key、代理私有 state | 8 KiB/项；不保存正文或凭据 |
| connection_config / connection_state | 来源实例配置、已确认游标、运行与学习统计 | 各 16 KiB，秘密只保存引用；详见 Connector 合同 |
| source_binding | connectionId+sourceKey、current/pending 修订/摘要、指纹与 job 映射、excluded | 32 KiB，不存源正文或事件历史；详见 Connector 合同 |

每个短期 admissionDecision 最多 1 KiB，包含 intent（temporary/normative/factual/causal/mixed）、persistence（task/window/durable/unclear）、futureUse（一句话，最多 256 B）、newValue/scopeComplete/supportAdequate 检查结果（pass/fail/unknown）、disposition（reject/merge/retain_active/retain_held）及 reason（最多 256 B）。服务对模型提案做校验；用户明确保留意图来自实际输入，不接受模型自报授权。决策仅用于解释为何存/不存，不是经验置信分或永久审计日志。

新增 retain_active 要求 supportAdequate=pass；retain_held 只允许证据尚未确定的 unknown，并要求 newValue/scopeComplete=pass、明确 futureUse、真实用户保留意图与 review。已被否定或来源无效的 fail 走 reject，不用 held 保存已知错误主张。该矩阵针对新增准入；既有经验的暂停/纠错按生命周期规则执行。

learning_job 只保留材料与进度，不永久复制 8 份完整 proposal；逐条形成 write_operation，结果统一为 results: {id,revision}[]，不同时维护重复 resultIds。纠正可有 correction: {target?:{id,revision}, pauseConfirmed?:{id,revision}}，仅当服务已确认目标暂停时写 pauseConfirmed；它是完成事实，不是当前有效性凭据。queued/running/completed/failed/uncertain 表示作业结果；有限错误信息最多 512 B，不包含原始模型响应。明确失败材料到期可清理，uncertain 所需内容在修复前不能清理。

stage 使用 extract/assess/consolidate/write，assess 表示准入或复评；write_operation.operation 为 add/update/disable/delete，状态为 prepared/uncertain/confirmed。add/update/disable 保存完整拟写经验或精确待写 payload，用于核对目标修订；delete 只需要目标。

Connector 来源的 LearningJob 另有 bindingId、sourceRevision、partKey，服务以它们确定稳定接收身份，写入前验证来源仍有效。一份源对象修订最多 8 个材料作业，每作业仍最多 8 条 proposal。

由学习作业生成的 write_operation 必须携带 jobId 与 itemIndex（0–7），管理记录 ID 按该对稳定生成或由作业提前绑定。Mem0 写确认后先持久化 job 的已完成项与结果 id/revision，暂停事实也先登记到 job，再清理对应操作；任何一个结果尚未确认都保留操作。重启先核对已绑定操作，不能为相同条目重新提取并 add。关联只存在于短期管理对象，不进入经验模型。

ScopeDefinition 的 allowedAdapters 和默认集合映射仅由已认证用户配置，任务中的 scopeId 不能给适配器新增授权。

同一数据库的多个 point 也不具备应用事务。管理写确认前不修改经验，管理记录缺失或不可用按架构要求进入维护；持久化幂等身份不能自动解决迟到更新。运行时队列容量和每日模型预算可配置，满载返回 backpressure，不丢弃已确认接收的材料。

## 纠正回执的响应合同

receipt 由写响应或 getJob 基于现有短期 job、写操作和当前经验生成，不单独持久化通知流。适用于 revise 与 corrective feedback；普通 helpful/irrelevant 不生成虚假的规则更新结果。字段总量最大 2 KiB，错误原因≤512 B，经验正文从当前授权记录读取，不在回执表再复制。

| 字段 | 形状 | 语义 |
|---|---|---|
| accepted | boolean | true 仅表示处理输入可靠持久化；记录到期后无法查询不能反推未接收 |
| target | 可选 {id,revision} | 已明确的被纠正版本；歧义或无权限不捏造/泄露目标 |
| previousUse | not_targeted/not_confirmed/suppressed/superseded/unknown | 无旧目标、未确认暂停、目标已不可投递、被后续版本替代、当前无法确认 |
| replacement | {status,id?,revision?} | status=pending/effective/not_effective/unknown，id/revision 必须来自已登记结果 |
| reason | 可选短代码与说明 | 如 awaiting_evidence、temporary_only、target_ambiguous、version_conflict、failed、scheduled、updated_again |

accepted、previousUse 和 replacement 是独立事实。job.completed 可以表示零经验、held 或已写入未来生效记录，不能直接映射 effective。只有结果修订、文本/向量/metadata 完成确认、屏障解除、当前来源/依赖与有效时间满足自动资格，才能 replacement.status=effective；它不要求当前任务必须 applicable，更不保证任意搜索命中。

getJob 的 receipt 每次重读当前权限和结果。若结果又被修订则不继续把该历史结果标 effective，reason=updated_again；删除/权限不足不返回隐藏文本；无法确认时 unknown。previousUse=suppressed 只表明指定旧版当前不能投递，不能把它解释为所有替代经验都被停用。已确认暂停而更新失败时，可同时是 suppressed 和 not_effective。

前端跟踪 jobId 的显示状态使用短期请求序号去重，丢弃过期、取消或被新读取替代的响应。快速完成仅一次最终确认；长作业把同一进行中显示更新为最终结果。会话已关闭时保留 UI/CLI 可查结果至作业保留期，不启动新 Agent 补发通知；没有新永久消息记录或投递事件表。

## 示例

下面示例表示用户明确采用的工程约束，归属工作集合并可跨仓库使用。它是 reported/attributed 的本人要求，不宣称用户原话已证明一个普遍因果原则。内容仅说明字段；若原话只是转述客观结论，应改用相应 purpose 并按证据核验后才决定 active。

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
