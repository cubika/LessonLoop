# Mem0/Qdrant 原型设计

日期：2026-09-14。范围：保留 2026-09-13 P0 原型的存储、索引和恢复设计，供复现与对照。以下包含尚未实现的要求，不等于所有检查已通过。当前产品架构见[系统架构](../../03-architecture.md)，实际结果见[P0 实测记录](README.md)。

原型使用 TypeScript、Mem0 OSS 与 Qdrant：领域提取后逐条 infer:false 写入，Qdrant 是该配置的唯一数据库。Mem0 ID 直接用作原型经验 ID，MemoryGateway 同时承担厂商调用、Qdrant 查询和控制状态存储。目标架构拆分这些职责并引入稳定产品 ID，以下物理约定不限制 Hindsight。

该原型代码已删除，不再维护运行入口；查看旧源码的方法见[实测记录](README.md)。M01–M11 只用于解释这套历史合同，新引擎执行独立的 E 系列合同。

## 能力分工

| 能力 | 负责组件 | 实现边界 |
|---|---|---|
| 经验读写与语义召回 | Mem0 | 保存结构化 metadata，基于 memory 文本生成嵌入和候选 |
| 范围、状态、时间、层次、主题筛选 | Qdrant payload 索引 | 网关规范化过滤，候选返回前复核 |
| 精确实体与指定字段查询 | Qdrant 原生过滤 | keyword 精确值与 text 分词语义分别声明，不等同于通用相关性排序 |
| 来源与依赖查找 | Qdrant 字段查询 + 应用 | payload 保存来源指纹和依赖 ID，应用验证修订与适用性 |
| 浏览与完整导出 | 网关封装 Qdrant scroll | Mem0 getAll 未暴露完整游标；一致导出须确认写入已结束 |
| 学习任务与恢复 | 应用单写者 + Qdrant 管理记录 | 有限调度与未知结果隔离，不承诺跨 collection 事务 |
| 纠错与来源删除 | 应用策略 + Mem0/Qdrant | 当前修订、必要删除记录和来源清理，不提供首版历史回滚 |

领域层负责多层提炼、反例判断和经验整理；结论是否成立需要它依据材料判断，不能交给存储框架。

## 存储与组件边界

应用使用两个 Qdrant collection：Mem0 管理经验，`lessonloop_operations` 保存运行和配置数据。后者按 recordType 区分集合配置、短期作业、未确认操作、来源控制、连接配置与游标、源对象绑定、代理 checkpoint，不复制当前经验。字段、保留期和容量见[存储数据模型](../../07-storage-model.md)。Mem0 如需创建实体辅助 collection，仍使用同一 Qdrant 后端并自行管理。

管理记录使用不含语义嵌入的 payload points，不参与经验召回。作业完成后按保留期清理材料，未确认操作留到修复完成。领取顺序、预算和退避由单进程单写者控制；首期不支持多实例抢占，也不依赖跨 collection 原子提交。

| 组件 | 职责 |
|---|---|
| CoreService | 本地认证、范围、经验操作、单写者协调 |
| LearningService | 持续意图与价值准入、L1–L5、证据判定、条件/例外、来源绑定与有限复评 |
| MemoryGateway | Mem0 读写/语义检索，内部 Qdrant 字段查询/scroll/管理记录 |
| RetrievalService | 任务理解、查询模式选择、当前状态和适用性检查 |
| JobRunner | 有限作业调度、预算、确定失败重试、未知结果隔离 |
| ConnectorRuntime | 同步计划、分页接收、游标、重试/背压、源对象修订；不执行领域提炼 |
| Connectors / AgentAdapters | 外部来源协议或代理采集/消费与身份映射，不直接写数据库 |

TypeScript 服务统一接口类型，接入 Mem0、Qdrant 和可选 Copilot SDK。Copilot 内容采集与提取模型分别实现。ConnectorRuntime 处理通用定时和同步管理，各 Connector 负责来源认证、读取、转换，邮箱或知识库协议不进入 LearningCore。游标与源绑定经同一网关保存，凭据存入系统凭据设施。

核验基线为 `mem0ai 3.1.8`，源码 `c7ee362aff94a369af70f13f2b4f853f6793ff4c`。实施时须固定实际包、Qdrant client/server 和模型版本，显式配置 Qdrant provider 与 `disableHistory: true`，避免默认 history 使用 SQLite。P0 已在加载适配下检查无 SQLite 数据文件；正式打包仍须重验启动、读写、更新、删除和重启全过程。

## 经验字段与索引

Mem0 ID 直接作为经验 ID；`user_id` 使用稳定用户身份，不默认以 `agent_id=copilot` 隔离共享经验。`ll_record` 保存除 ID/revision 外的结构字段；服务由 Mem0 外层 ID 与 `ll_revision` 组装对象。`ll_schema` 只标记格式版本。

每次拟写的唯一 `ll_write_nonce` 在调用 Mem0 前同时写入管理记录和待写 metadata，用原生精确过滤定位未知 add 的结果。它仅标识一次写操作，不参与领域修订或材料事件模型；查无结果不能证明旧请求已失败。

Mem0 memory 由带字段标签的结论、conditions.text、主题和实体组成，用于生成向量。例外单独放在 metadata 中；metadata 内容不会自动进入语义检索。

同一经验 payload 包含从正文结构生成的查询字段：scope、state、applicability、basis、assessment、level、purpose、topics、entities、数值时间、sourceFingerprints 和依赖经验 ID。按实际查询建立 Qdrant keyword、数值或 text 索引，不建 SQLite 镜像。写入再读回时须核对查询字段与原结构一致。

scopeId 只控制知识归属与访问，applicability/conditions/exceptions 定义适用范围。repo、branch 等上下文在有限候选中判断，首版不为任意 key 建索引。采集位置不自动成为适用限制，也不能按当前 repo 过滤掉未限定 repo 的通用经验。

精确标识符保留完整值和大小写。Qdrant keyword 按完整字符串匹配，不查任意子串或同义词。要精确查到条件中的代码或参数名，必须把它提取到标识符字段。text 索引用于指定字段的词项过滤，中文分词和短语行为另做测试；这不等于已实现 BM25 排序。

结论、条件、主题和实体改变时，网关重新构建 memory，并同次 update 文本与 metadata；例外等字段更新也产生新领域 revision。非文本更新可能仍重新嵌入，接受并记录该版本成本。每次修改后读回核验；文本、metadata 和字段索引均以同一 Qdrant 记录为依据。

## 历史索引映射与专用预算

以下保留已删除 Mem0/Qdrant 原型的物理映射，不是当前可运行功能，也不限制其他引擎。

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

| 历史专用预算 | 上限 | 计算范围 |
|---|---|---|
| Mem0 memory 检索文本 | 4 KiB | 同时不得超过选定 embedding 模型的 token 限制 |
| 应用控制的持久 payload | 32 KiB | memory、ll_record、索引投影及应用 metadata；不含向量和引擎内部字段 |

超限检查发生在 Mem0 调用前，检索文本超限返回 search_text_too_large；不能截断内容后保留原判定。产品 Experience、Material 与管理记录的通用容量仍见[数据模型](../../07-storage-model.md)。

## 查询路径

1. 根据可信调用身份确定授权 scope，和请求集合求交；未知范围不回退全库。
2. 默认自然语言查询调用 Mem0 semantic search，预先传范围、状态、时间及显式筛选，不能在全局 top-k 后才补做。
3. 显式精确实体/标识符、来源、依赖或字段查询由网关调用 Qdrant 原生过滤；它独立于语义 top-k，能够找到未进入语义候选的精确值。不默认开发跨库 rank fusion。
4. 读取 Mem0 当前记录，复核授权、revision、active 与合法 purpose/basis/assessment、有效期、写屏障、来源和依赖；持久 applicability=unknown 不进入自动返回。先判目标相关，再检查全部条件/例外：明确不满足优先排除，仅当次缺可核实信息才 undetermined，条件齐备为 applicable。
5. applicable 返回 usage=guidance；undetermined 仅对 includeLeads=true 且理解协议的客户端返回 usage=lead，并含相关原因和 missingChecks。总共最多 3 项、约 800 token，线索最多 1 项，优先放可采用经验；完整条件/例外和用途标签不可截断。evidence 默认不返回。

同一接口接收语义、精确和字段查询，各模式明确自己的匹配与排序规则。以后若需要稠密与稀疏向量联合排序，先测试 Qdrant 原生能力；目前尚未完成，也不据此增加数据库。

指定 exceptions 的字段查询使用 browse 的显式调查入口，返回“排除条件匹配”，不能自动包装成 guidance 或 lead；recall 不接受该字段。自动召回仍检查例外，已确认命中时排除；仅缺少排除例外所需的当前信息，才可在合格候选中形成具体线索。

空查询使用 Qdrant scroll 浏览，不产生嵌入。cursor 包含后端 offset 与绑定的授权/筛选摘要，逐页仍校验权限。并发更新下不承诺快照分页；完整导出在维护窗口停止相关新写入并确认已发写全部结束后进行。Mem0 getAll 的有限返回不能冒充完整导出。

所有内容出口共用权限与来源检查。user_forget/erase 阻止正文读取；superseded/withdrawn 停止自动建议，但授权详情可说明来源已失效。确认访问权被撤销后，暂停该连接来源的自动使用。

inspect 只返回当前经验，引用的历史原文未保留时须如实说明。browse 可按请求查看 held/disabled。recall 的 guidance 和 lead 都只能来自符合资格的 active，includeLeads 不放宽证据或来源要求。

依赖最多展开 32 条、深度 5，引用父修订须仍为当前且可用。失效、循环或超过预算不返回派生建议；反向索引仅调度后台重评。Qdrant 数值有效期过滤须在限额前生效，最终再复核，不依赖 Mem0 的候选后 expiry 过滤。

Qdrant 或管理记录不可读时不返回经验；嵌入服务失败时显式精确/字段查询仍可运行，语义查询报告不可用。各查询模式分别报告自身可用性。

启动时若已有经验数据但管理 collection 缺失，进入维护状态，不能创建空管理集合后把未知写入与删除记录当作不存在。全新空库可以正常初始化；管理内容丢失则按恢复限制处理。

## 自动召回调度

AgentAdapter 在新任务开始时调用 recall，于首次规划或行动前回填。采用经验前定向刷新，影响判断的上下文或目标变化时合并补充请求；模型可以主动调用 MCP。具体触发和降级规则见[接口文档](../../04-contracts-and-extensions.md)，不为每次工具调用重新搜索全库。

任务/上下文关联、相同输入去重与在途响应序号使用消费端短期状态；取消、超时或被新请求替代的响应一律丢弃。首次请求超时不阻塞原任务，不把未返回/迟到结果当作已使用。宿主没有必要 hook 或回填能力时明确标为受限，不能以工具注册成功通过验收。

## 当次核实与状态刷新

taskApplicability、missingChecks、检查次数和当前上下文只放在请求或消费端任务缓存中，不新增 Qdrant 记录。定向 recall 按 target.id 读取，先检查访问资格，再核对 target.revision；不能用搜索 top-k 代替精确核验，也不能用旧问题验证新版本。通用搜索可以在预算内补取，结果不足时不扩大权限。

客户端按任务+经验 ID 记录最多两轮检查；改排序、修订变化、重新 recall 不自动重置同任务的检查预算。重启丢失预算时保守停止该旧线索的自动检查，新的真实用户任务可建立新预算。无新信息、权限不足和工具错误只影响本次使用，不改持久 state。

支持 lead 的适配器先核实，再采用；依据经验开始新动作前定向刷新，动作所依赖的上下文变化也会使旧判定失效。核心只保证响应组装时的当前性，无法回收已投递文本或控制宿主后续所有行为。服务不可用时，客户端缓存不能继续提供指导资格。

## 准入执行与复评

LearningService 按[准入规则](../../02-experience-model.md)作出 reject/merge/retain_active/retain_held，服务独立校验来源角色、scope 权限、字段、允许状态和期限。不合格 proposal 只在 LearningJob 留短期原因，不能默认写成 held。

reviewBy 的到期扫描和新证据触发的复评使用现有 JobRunner，不新增晋级引擎。到期处理携带目标 revision，和补证/用户操作串行核对；不能用旧任务停用新版本。review 与 evidence 变化也沿用 Mem0 当前记录更新路径。

核心只检查已有材料。review.question 和 missingChecks.question 提出待核实问题，不授权执行命令。新读取或测试须在宿主已有权限内完成；当次上下文结果用 recall 重评，主张补证才通过 verificationFor 重新准入。

## 作业、修改与删除

submitMaterial 只有在 Qdrant 作业写入被确认后才返回已接收。控制写本身结果未知时不继续修改经验，按已知操作 ID 核对。管理记录不是另一个经验版本系统，已完成任务不长期保留输入。

一次修改在同一写协调中完成：读取当前经验并比较 expectedRevision，确认管理记录已持久化，再调用 Mem0，读回结果，最后结束操作记录。旧操作结果未知时，按 nonce 或经验 ID 暂停投递和后续写入。读取出口在组装响应前检查这些状态，但无法收回已交给代理的内容。

Mem0 add 在内部生成 ID，update 没有应用级 CAS。只有确认持久写请求尚未发出，失败后才可直接重试。Promise 报错、超时或一次查无结果时，仍可能已经写入；不能用 Promise.race 超时后就释放写协调并提交下一版。

管理 CLI 列出受阻操作，隔离旧写者并确认已发请求结束，按 nonce/ID 核对后恢复或继续隔离。已完成写只结束管理记录，不重新 add；仍未知不盲重放。Qdrant 不提供这里所需的跨点/跨 collection 应用事务，不声称 exactly-once。

来源控制记录区分 source_superseded、source_withdrawn、source_erased 与 user_forget，行为以[Connector 合同](../../08-connectors.md)为准，不把普通更新当永久删除。来源删除先确认 scope+fingerprint 控制记录持久化；所有读取、排队提取和待写 proposal 检查它。字段索引加速定位，权威 scroll 完整清点当前经验、派生副本和短期作业；清理未确认之前不报告删除完成。

删除记录在有关任务可能重放、或产品管理备份仍可能含该材料时保留。首期不支持任意旧快照自动恢复：恢复须保留并重新应用现有删除记录，无法获得完整记录时进入维护与重新导入流程。把旧内容与旧删除记录一起回滚不能保证后来删除仍有效。

## 纠正处理的结果投影

revise/feedback 返回 jobId 和 receipt，getJob 按同一规则生成回执。作业持久化后才能报接收；目标屏障或当前不可投递状态确认后才能报暂停。新修订的文本、向量和 metadata 写完并读回一致，索引字段可读，相关屏障解除，且自动资格与有效时间都通过，才可报生效。

生效只表示可以参加正常召回，不保证任何查询都命中。receipt 从当前数据生成，不增加 Experience 状态或通知账本。

服务只在现有短期作业中保存明确纠正目标、已完成的暂停事实与结果 id/revision 等最小数据；待写操作确认后先登记作业结果再清理操作。读取 receipt 时在现有协调边界重验当前资格，历史 completed 不作为当前有效性的凭据。普通后台学习仍只更新工作状态，针对用户明确纠正的回执由前端跟踪显示。

## P0 闸门

实际运行须验证：无 SQLite 文件；逐条结构写入；metadata 过滤在 top-k 前执行；Qdrant 精确/字段查询；完整 scroll；无嵌入管理记录的持久化；控制写先确认；迟到写隔离；删除与重启。索引构建和恢复均在同一 Qdrant 内验证。

测试失败时先保留最小复现，再补足必要的网关能力或缩小首版范围。数据层始终限定为 Qdrant 一个数据库。
