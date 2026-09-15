# 数据模型与保留

日期：2026-09-15。状态：当前数据合同，主要对象和存储已有实现，进度见[13](13-implementation-plan.md)。本页是字段、预算和保留期的唯一维护位置；领域规则见[02](02-experience-model.md)，操作语义见[04](04-contracts-and-extensions.md)。

本开发版本采用产品格式 3，按当前格式初始化。格式 1、2 数据库会明确拒绝启动；本分支没有迁移旧数据，合并前需确认采用新库或另做迁移。当前格式的数据、控制和备份仍按本页保留与恢复。

## 数据所有权

核心只有 Source、Experience、Playbook，类型、API 字段与存储 kind 使用同一套名称。Source 一行保存一个片段及其控制状态；批量输入不产生另一个领域实体。WorkView 放在 core 中，是可选工作聚合缓存；使用视图直接读取当前任务反馈。

| 数据 | 权威位置 | 用途 |
|---|---|---|
| Source、WorkView 缓存、Experience、Playbook 元数据 | ProductStore | 工作输入、有范围的主张、身份、依据、发布状态和用户控制 |
| Playbook 当前正文 | Hindsight 独立方法 bank | 标题、目标、主题、条件、步骤、分支和检查项；不保存旧版正文 |
| 用户控制、版本和 SourceBinding | ProductStore | 纠正、停用、忘记、范围、来源变化和恢复 |
| PublishedProjection | 可重建索引 | 查询当前可投递对象，不决定产品状态 |
| 原文、chunks、原生 facts/observations、图与向量 | Hindsight 原生存储 | 提取、归纳、候选与依据读取 |
| LearningJob、WriteOperation | ProductStore | 有限作业、原生操作确认和失败恢复 |
| 工作缓存、任务反馈、结果判断材料与周期回顾 | ProductStore，单独授权 | 效果观察、当前结果与周期回顾；判断材料不进入学习bank |

产品和引擎可以使用同一 PostgreSQL 的独立 schema。不能修改厂商内部表或依赖跨服务数据库事务。现有评测 schema 只覆盖 Experience 的部分规则，不是本页模型的实现。

## 身份与引用

所有长期产品对象使用服务生成的 id、递增 revision、scopeId、createdAt、updatedAt。scope 表示归属和授权，主题、项目及分支条件不授予访问权限。ID 不由模型提供，不使用原生 Hindsight ID 作为产品身份。

跨对象引用采用 ObjectRef={kind,id,revision}，kind 为 source、experience 或 playbook。只有语义已明确限定单一对象的字段才省略 kind，例如 Experience.derivedFrom 只引用 Experience。作业结果、写操作、纠正回执和历史使用关联必须带 kind。

引用绑定实际支持修订。revision 改变表示正文、依据、边界或使用状态变化；索引重建本身不改领域修订。方法沿革不是支持引用，引用图禁止循环，首版 Playbook 不递归调用其他 Playbook。

## Source

Source.id 是服务计算的片段指纹，直接保存 segment={text,role,locator?,author?,observedAt?}、context、scopeId、revision、createdAt、updatedAt 和 blocked/erased/excluded。原始角色由可信接入绑定，普通 MCP 自报角色不取得用户或工具身份。

sourceIdentity 标识实际输入来源；sourceFamily 标识共同证据来源，只用于判断独立性；workKey 关联同一工作记录。taskRef 只在可信任务关联存在时保存。taskSequence 表示该工作的输入顺序，ordinal 保留一次提交内的片段顺序。不同 Connector 事件可以同属 sourceFamily，同时保有不同 workKey。

submitSource 接受 scopeId、segments，可选 context/sourceFor/verificationFor。它返回 Source 引用数组与 jobId；Source 本身不保存整批 segments。sourceFor={id,revision} 关联后续观察，verificationFor 指向待核实的 Experience 修订。Job.sourceIds 冻结有序输入，sourceRefs 保存输入与旧支持的完整依赖集合。
Evidence={excerpt,role,relation,fingerprint,locator?,author?,observedAt?}。relation 为 supports/contradicts，excerpt 保留连续原文。fingerprint 由服务对规范化片段与来源身份计算，不由模型设置；Connector 同时绑定连接、子资源和来源修订。相同文字的不同来源不合并归属，同源转载也不增加独立支持。

规范化使用 UTF-8、统一换行，保留改变含义的空白和代码。指纹输入逐字段长度编码，算法在实现中固定并跨重启验证。短摘录不替代原片段身份，根来源通过引用传递。

## 工作和使用视图

WorkView 缓存按 scopeId/workKey 定位，包含目标、尝试、结果、短证据、缺口及方法使用关联。它不属于 ObjectRef，不进入学习产出列表，Playbook 不引用缓存修订。缓存缺失时 getWorkView 返回 available=false；读视图不调用模型。

新输入重建工作快照，保留仍有来源的真实观察。source_sequence 同时记录接收顺序与已处理水位；较新作业零产出也推进水位，较旧结果不能覆盖新结果。跨工作复盘只能提炼经验和方法。

使用视图从当前任务反馈与真实用户评价生成。视图标签和摘要不成为独立学习证据；学习、效果记录和通知仍分别控制。
## Experience

| 字段 | 内容 |
|---|---|
| 公共身份 | id、revision、scopeId、createdAt、updatedAt |
| conclusion、purpose | 单一主张及用途；purpose=fact/constraint/lesson/procedure/rationale |
| level（可选） | L1–L5 分析标注；普通学习省略，已有标注保留，不影响发布、召回或方法资格 |
| applicability、conditions、exceptions | general/conditional/unknown，全局边界及例外 |
| topics、entities | 主题与精确实体，不把例外词当正向推荐条件 |
| basis、assessment | reported/observed/inferred；attributed/supported/hypothesis/contested |
| evidence、derivedFrom、sourceFingerprints | 原文或父经验修订、根来源集合；至少有 evidence 或 derivedFrom |
| state、review | active/held/disabled；held 必须有 review |
| validFrom、validUntil | 可选有效区间，省略表示对应方向不设边界 |

review={reason,question,reviewBy}；reason=verification_requested/conflict/source_changed/scope_unclear。active 不保留待复评标记，重新启用仍运行准入。constraint 专指真实本人偏好或有权设置的要求。依据判定由02定义，不以 level 或来源数量代替。

## Playbook 与版本

| 字段 | 内容 |
|---|---|
| 公共身份 | id、revision、scopeId、createdAt、updatedAt |
| title、goal、topics | 名称、要解决的问题和主题 |
| applicability、conditions、exceptions | 方法全局条件和例外 |
| steps | 有序 stepId、instruction、rationale?、supportIndexes、choices? |
| choices | {when,next}；when 为 Condition，next 为后续 stepId 或 stop |
| completionChecks、stopConditions | {text,stepIds?}；省略stepIds为全局检查，指定时仅在包含相应步骤的路径适用 |
| supportRefs | 同 scope 的 Experience 修订，步骤通过 supportIndexes 指向依据 |
| state、review、validFrom、validUntil | 与产品资格共用的使用状态、复评和有效期 |
| change | kind=create/refine/branch/split/retire/correction、summary、predecessors |

predecessors 保存被本次方法修订或拆分替代的 Playbook ObjectRef，仅表示沿革。长期事实支持由 supportRefs 承担，工作记录从支持经验的 Source 引用展开。

方法按 steps 顺序开始。无 choices 时进入下一步；有 choices 时，在对应步骤完成后判断，只有恰好一条匹配且其他条明确不匹配才推进。零匹配、多匹配或未知时由 Agent 继续调查或询问；没有隐含默认路径，条件和跳转不允许循环或悬空。

检查引用的stepIds须存在。prepare返回全部完成检查和停止条件，保留stepIds以说明路径归属。Agent执行全局及所选路径的检查；未选分支不作为本次完成要求。返回指导或完成某一步不代表任务成功。无需执行DSL或服务端逐步推进。

Playbook 只维护当前正文。ProductStore 保存 contentHash、planHash、当前 revision、supportRefs 和用户控制；revision 用于冲突检测和真实使用关联，不表示可恢复的历史版本。playbook_write 暂存通过审查的候选与唯一 token，保留所有可能仍存在于原生正文中的旧依据，直到写入读回确认后删除。原生正文读取还要重新校验哈希。

## Condition 与任务准备

Condition={text,match?}；match={key,values} 表示已规范化上下文值属于给定集合。text 必须与 match 等价；方法自由文本条件由工作 Agent 结合实际任务观察判断，直接经验定向核实仍使用 contextEvidence，不支持任意代码或正则执行。未知值保持未知，路径和版本不能用裸前缀相似来猜测。

方法全局条件为 AND，例外任一成立就排除。分支条件只在相应决策点判断，不要求所有互斥分支同时成立。支持经验的当前资格先统一检查，本次适用性按方法与当前路径判断。

Task保留归属、范围、结束状态和创建时间，每次获取方法都检查任务仍有效。任务反馈按taskRef存储，方法以id/revision关联，不另建使用标识或执行会话。

## 发布投影与引擎映射

PublishedProjection 保存 ObjectRef、scope、eligibilityVersion、有效期和检索文本。查询在候选限额前过滤当前可投递集合，随后由核心重查状态、来源与支持。原生未发布事实不能占满产品 top-k。

EngineBinding 保存 objectRef、backendInstanceId、engineType、processingConfigVersion、nativeRefs、sourceRefs、dependencyCoverage、checkState、checkedAt。Experience 绑定其实际原生依据，每个 Playbook 绑定独立方法 bank 的 current mental model；检索投影仍单独确认。

来源重处理或原生 ID 改变后，依据来源和主张重新绑定；无法确认则暂停，不只依赖文字相似。索引写入读回和产品修订一致后才解除发布屏障。

Hindsight 原生字段包括 id/text/type/context、字符串 metadata、tags、entities、时间和来源引用。metadata/tags 可承载映射或检索条件，不自动执行产品状态、L1–L5 或方法分支。映射不修改原生表结构，索引同步能力须固定版本验收。

## 作业、写操作与来源绑定

LearningJob 保存 id、scopeId、kind、stage、status、sourceIds、sourceRefs、results、decisions、engineOperations 和 cancelRequestedAt。kind=case_review/synthesis/playbook_update；stage=queued/extract/compose/assess/publish/done。作业固定使用独立引擎空间，单一当前学习 Schema；不保留旧 profile 的兼容分支。

Copilot 会话来源全部保留，学习作业使用最近至多192段、128 KiB的窗口，超出窗口的历史来源不删除。WorkView 可按新窗口替换当前摘要；同一会话不维护多个主题案例，已发布经验仍保留。来源族、workKey与发布序号跨窗口保持一致。

取消先持久化cancelRequestedAt并停止新步骤；已发原生操作继续核对或使用真实取消能力，结果未知保持uncertain且不发布新的产品结果。已发操作均有明确处置后才转canceled，原生迟到候选按材料策略清理；取消前已确认发布的对象保留，不隐式回滚。重启先读取消意图，不重新调度；已终结作业的取消请求幂等返回当前状态。

results 使用 ObjectRef。decisions 记录未来用途、范围、支持判定和 reject/merge/retain_active/retain_held 处置，不保存模型长推理。engineOperation 绑定实例、产品作业身份、原生 operation ID、处理配置、来源修订和最近核对状态；提交前保存关联，超时先核对而非重提。

WriteOperation 保存 ObjectRef、expectedRevision、operation、status、拟写内容与 jobId/itemIndex。operation=add/update/disable/delete，status=prepared/uncertain/confirmed。SourceControl 保存明确类型的目标、来源指纹/绑定、动作及原因，用于停用、替代、撤回、擦除与永久忘记；所有纠正和暂停回执都引用真实确认的对象版本。

SourceBinding 以 connectionId+sourceKey 唯一定位资源，保存 parentSourceKey?、mutation、correctsRef?、sourceRevision、内容摘要、current/pending、指纹、作业及 excluded。snapshot 替换资源当前修订；append 每事件使用独立稳定子资源；correct 明确指向同连接中的旧事件修订。相同事件键不同内容无明确纠正语义则报冲突。

来源绑定、接收标记和去重信息在有引用、未完成操作或可能重放期间保留。父任务忘记标记 excluded，清点子资源并拒收后续事件。连接游标只能在可靠接收后推进，不能代表已学会。

## 效果记录

task_feedback是唯一反馈主记录，id为taskRef。每个任务保存taskOutcome/outcomeText，feedback数组按playbookId/revision保存delivered、userRating和ratingText；最多8个方法版本。投递和评价未知为null，结果未知为unknown。方法正文中的步骤和检查仍完整保留。

结果附outcomeSource=ai/host/user、可选outcomeEvidence=[{role,excerpt}]及outcomeAssessment=pending/completed/unavailable；旧记录可无来源字段。实际Copilot会话附outcomeScope=session。AI引用绑定原始观察，人工或宿主填写结果时清除旧AI引用；outcomeAssessment表示判断服务的状态，不替代taskOutcome。汇总按outcomeSources分别统计ai/user/host/unspecified。

task_outcome是每会话一条的持久处理状态，保存检查点、有界观察、事件时间、缺口、唯一token、状态、尝试次数和重试时间。它不创建学习来源或Hindsight bank。新材料令旧AI判断失效；模型返回后重查token、反馈是否仍可写、回顾开关和来源清理状态，过期结果不能覆盖新材料或人工结论。失败最多尝试3次，耗尽后为unavailable；判断服务失败不记为任务failed。已知材料缺口或缺少用户目标时直接保留unknown，不调用模型。

写入使用整条记录的revision检查，同值重试不产生新版本。清空擦除字段并保留递增版本的空标记，到期按整条记录删除。outcomeGeneration在清空、关闭回顾或关联来源清理时递增；宿主提交须匹配当前generation，旧检查点和在途判断不得恢复已清理材料。读取无需事件归并，问题复核引用记录修订。更新宿主与核心时，启动迁移一次性保留旧记录的最终事实并删除事件、使用关联和评价收据；旧确认问题需重新复核。WorkView不再包含方法使用关联。

反馈按回顾开关独立保存，关闭后停止新写入并清理待判断材料，已完成反馈仍可查看。重新开启不补收关闭期间的材料；缺口保留为unknown。关联来源擦除会清理该会话的判断材料及受影响的AI结果和引用，迟到输入仍受generation及擦除标记约束。清空反馈不会删除独立保留的学习来源。未知结果不按成功计。

## 保留与删除

| 内容 | 默认策略 |
|---|---|
| 已完成学习作业的完整材料与未发布提案 | 完成后 7 天清理；不形成永久候选库 |
| 失败作业材料 | 最多 30 天，保留失败和来源定位 |
| 已确认取消作业的材料 | 取消确认后 7 天清理；先清点原生迟到副本，已发布对象独立保留 |
| 未完成或 uncertain 所需材料 | 保留至操作确认或修复，不按完成期限误删 |
| WorkView | 原始观察后 30 天；追加不重置旧证据期限 |
| 当前 Experience、Playbook | 长期保留当前内容、获准短证据及引用，直到用户删除或来源策略要求清理 |
| Playbook 旧版 | 不保留；产品历史恢复入口与原生 mental model 历史均关闭 |
| task_feedback、task_outcome及使用视图 | 任务创建后30天，评价、更正和重新准备不延期；清空回顾同时清理判断材料 |
| EffectSummary | 90 天；无任务正文，贡献关联随删除或到期清理 |
| 方法获取所关联的Task | 普通任务创建后最长24小时；Copilot会话按最后宿主回调后的24小时空闲时间检查，恢复会话沿用原引用 |
| SourceBinding、SourceControl、EngineBinding | 有依赖、恢复或重放需要时保留，正文最小化 |
| 用户另存导出文件 | 独立快照，不属于服务可远程撤回范围 |

发布前将获准的必要案例证据保存为 Experience 支持，不能只引用会过期的案例 URL。禁止复制或来源到期时停止相关使用，不擅自延长保留。清空效果记录只清统计；忘记或擦除来源须传播到 WorkView、Experience、Playbook、临时候选和原生副本。

Hindsight 的 document/chunks、基础事实和派生结果有独立保留关系。默认发行 profile 必须明确实际副本策略；无法同时满足材料清理和方法依据保留时，按[决策记录](06-review-and-decisions.md)处理，不能只清作业就报告原文已删除。

## 预算

预算是初始设计上限，不代表已有性能保证。实现前按 profile 固定；改变上限需同步本页和验收配置，不在各接口页重复定义。

| 对象或操作 | 上限 |
|---|---|
| Source 提交 | 32 KiB；最多16个片段；context 32 keys，key 64 B、每值128 B或最多4值 |
| WorkView | 64 KiB；16 attempts，每项2 KiB；16 Evidence |
| Experience | 16 KiB；conclusion 2 KiB；conditions/exceptions各4；topics8；entities16；derivedFrom8；根指纹32 |
| Evidence | 单摘录512 B；Experience最多3项且总2 KiB；使用视图同限；WorkView最多16项 |
| Playbook | 32 KiB；title256 B、goal1 KiB；12 steps，instruction1 KiB、rationale512 B；每步4 choices；16 supportRefs |
| 检查与变化 | completionChecks/stopConditions各4项，每项text512 B、stepIds最多12；change.summary1 KiB、predecessors4 |
| Condition / review | text/question512 B；match最多4值；review整体1 KiB，默认30天 |
| 学习作业 | 64 KiB、8提案；Playbook正文一次最多1份，超限拆关联作业；单次最多192个来源片段、20相关对象，组装最多2次模型调用 |
| 控制记录 | WriteOperation48 KiB；SourceControl2 KiB；SourceBinding32 KiB；连接配置16 KiB、游标8 KiB |
| 依赖展开 | 一个方法或经验请求共32个经验、深度5；超限不取得使用资格 |
| 方法搜索 | 请求16 KiB；最多3个摘要，约800 token；摘要不带执行资格 |
| 方法准备 | 请求16 KiB；一个方法自动视图2400 token，显式expanded最多8192 token且不超正文容量 |
| 直接经验召回 | 请求16 KiB；最多3项、约800 token，最多1个lead；不与方法视图默认叠加 |
| 观察与回顾 | 单任务64 KiB、关联对象64；使用视图8 KiB；每日1000任务/100新效果案例 |
| Copilot结果判断材料 | 每会话最多192条观察、120 KiB；提交整体128 KiB；单条观察28000字符，宿主同时检查28000 B；最多32项缺口，结果说明512字符、引用最多8条且每条512字符 |
| Connector批次 | 256 KiB、最多8个Source片段；超长对象使用稳定子资源 |

结果判断材料超出预算时保留早期目标和较新观察，并记录不可恢复缺口；该会话只能自动得到unknown。中途开始采集、材料替换或擦除也保留缺口。暂时无法读取或身份尚未匹配的transcript可在后续完整读取后恢复，不永久沿用已消除的读取缺口。

字节按 UTF-8 计算，token 单独计量。完整限制放不下则少返回、分片或报错，不截断后声称完整。引擎内部提取/归纳的次数、总 token、期限、取消和费用上限在 P0 冻结；无法精确限制的项标为可计量，并提供总体调度/取消控制。产品预算不等于数据库物理大小。
