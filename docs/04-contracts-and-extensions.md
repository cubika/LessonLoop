# 接口与 Agent 接入

日期：2026-09-15。状态：当前应用合同，主要接口已有实现，剩余差距见[13](13-implementation-plan.md)；操作表包含尚未开放的目标接口。方法名属于 LessonLoop API，字段与容量见[07](07-storage-model.md)。

## 调用原则

UI、CLI、AgentAdapter 与 Connector 使用同一带版本核心 API。认证身份、授权 scope 和适配能力由服务配置确定，模型不能填写身份字段取得权限。所有修改检查 expectedRevision，写结果未知时返回 uncertain，不把 jobId 当作发布成功。

公开 ObjectRef={kind,id,revision} 的 kind 为 source、experience 或 playbook。Source 的 id 是片段指纹；一次提交多个片段返回多个 Source 引用，批次没有独立领域 ID。scopeIds 与调用者授权求交，知识主题和 context 不扩大访问范围。

## 输入与学习操作

| 操作 | 主要输入 | 输出与行为 |
|---|---|---|
| submitSource | scopeId、segments，可选context/sourceFor/verificationFor | 返回 sources 引用数组与 jobId；sourceFor={id,revision} 补充已有来源的后续结果，核心保留原任务与工作关联 |
| listSources / inspectSource | 授权范围 / id | 片段身份、控制状态和仍保留的原文；正文过期或擦除明确标记 |
| controlSource | id、expectedRevision、action | 撤回、擦除或永久忘记指定来源，传播到依赖及副本 |
| getWorkView | kind=source/experience/playbook、id | 按需返回相关工作记录及来源引用，不公开 WorkView 身份 |
| reviewTopic | scopeId、topic | 在当前有界材料中创建复盘作业，不执行真实任务 |
| getJob | id | 当前阶段、Experience/Playbook 产出、处置与回执；隐藏内部材料和案例引用，正常完成可以零产出 |
| cancelJob | jobId | 停止未发的新步骤；已发原生操作须确认，不能伪报取消成功 |

普通 MCP 提交按实际 agent/external 归属保存。可信宿主才可绑定 user/tool 原文，验证 excerpt 相同不等于验证来源角色。补证目标必须同 scope、当前修订且可访问；新事实来源不能自动变成本次任务的事实，反向也一样。

首版内部规范化经验和方法默认英文，可配置；原文保留原语言，UI 可以中文显示。翻译不改来源或自动产生新领域修订，中英召回单独验收。

## 方法库操作

| 操作 | 行为 |
|---|---|
| searchPlaybooks | 按query和授权范围内scopeIds检索已发布方法摘要；当前条件在prepare中核对 |
| browsePlaybooks | UI/CLI按scope、状态、主题、query和cursor分页查看有权限的active/held/disabled方法；不自动注入，cursor绑定筛选范围 |
| pinPlaybook | 用户按id/pinned保存常用标记，不改变方法正文或发布修订 |
| inspectPlaybook | 查看当前方法、步骤、来源和状态，可查看有权限的暂停项 |
| preparePlaybook | 为任务返回完整方法指导，见下节 |
| revisePlaybook | 修改目标、步骤、条件或纠正说明，先保存临时候选；自动审查通过后，直接提交该候选并读回确认，不再次生成 |
| setPlaybookState | active/disabled请求；重新启用仍核对依据，不强制跳过准入 |
| removePlaybook | 先停止投递，再清理当前、待写候选和投影；默认保留仍有用途的基础经验 |
| exportPlaybook | 输出Markdown/checklist/skill快照，预览范围和版本，不安装或执行 |

用户约束、来源删除和方法纠正不允许通过原生 UI 或工具绕过产品控制。核心可复用官方管理实现，但产品修改必须保留自己的版本和意图。

## 方法使用与结果回传

preparePlaybook 输入 playbookId/revision、taskRef，可选 requestId 和 viewMode=auto/expanded。一次返回完整指导，无需提交步骤完成记录或调用 reassessTask；该旧接口已移除。taskRef 由核心创建并绑定调用身份，不能用任意字符串冒充其他任务。UI 可选择当前有权访问的同范围宿主任务。

核心核对任务身份、范围、结束状态和期限，以及方法当前修订、发布状态、有效期、来源和支持经验。工作 Agent 根据现场信息判断全局条件、例外和分支。搜索相关不等于本次适用，指定方法也必须检查这些边界。

| 准备结果 | 含义与返回 |
|---|---|
| guidance | 完整条件、步骤/分支、全部检查及其stepIds、executionBoundary、ObjectRef；回顾开启时附feedbackRevision供更新反馈 |
| target_changed | 旧revision过期，丢弃旧视图后重新准备 |
| target_unavailable | 不存在、无权或资格失效；不泄露隐藏详情 |
| requires_expansion / too_large | 自动预算不足可显式expanded；显式上限仍不足则不提供残缺视图 |
| unavailable | 引擎、存储或核对失败；不能当作“没有相关方法” |

Agent 从第一个步骤开始，无 choices 时继续下一步；有 choices 时完成该步骤，再根据当前观察选择唯一匹配的 next 或 stop。条件缺失、无匹配或多匹配时调查或询问。完整展示所有分支便于理解，执行时只走所选路径，并应用全局及该路径绑定的检查。执行后才能得知的结果须来自本轮实际操作，不能用旧结果代替。

preparePlaybook 每次重查当前资格；未结束且未过期的任务在核心重启后仍可获取方法。回顾开启时，在任务反馈中登记方法id和revision，重复获取不增加记录或重置结果。

学习直接使用来源材料和可信工具观察，不复制方法使用关联。任务反馈只保存当前投递、结果和评价，返回方法不代表投递或成功。

## 直接经验操作

recallExperiences、browseExperiences、inspectExperience、reviseExperience、setExperienceState、removeExperience 用于 Experience。召回在资格过滤后限额，返回 guidance 或 lead；显式浏览可查看有权限的 held/disabled 项，不转为自动指导。

recall输入query、scopeIds、context，可选includeLeads、target={id,revision}和contextEvidence={taskRef,observationIds?}。补查只引用核心保存的宿主观察，绑定目标修订并核对观察变化；普通context不能自授可信身份。线索列出条件/例外的具体缺口；补查后定向重评，不将当次适用性永久写回。跨scope材料不能自动用于修改原范围的经验。

经验revise({id,expectedRevision,correctionText})复用用户incorrect反馈，先暂停，再通过verificationFor补证审查；不直接把用户改稿当已验证事实。

feedback输入ObjectRef、helpful/irrelevant/incorrect和可选correctionText。helpful是评价，irrelevant是本次不相关，均不直接增加事实支持。可信用户明确纠错可先暂停指定旧版；代理怀疑形成待检查反馈，不冒领用户修改意图。

## 纠正回执

所有修改和getJob根据当前事实生成receipt，不复用历史completed宣称仍有效。回执字段统一为accepted、target ObjectRef?、previousUse、replacement、reason。

| 回执 | 服务确认条件 |
|---|---|
| accepted=true | 输入及作业可靠持久化 |
| previousUse=unchanged | 普通编辑送审时当前有效方法继续使用；后续来源或用户控制仍可立即暂停它 |
| previousUse=suppressed | 明确旧对象及修订，产品屏障已生效，旧版不再投递 |
| replacement.status=effective | 新ObjectRef当前通过准入，产品与投影一致且必要索引确认，写屏障解除 |
| pending/not_effective/unknown | 未完成、依据不足、临时要求、冲突或结果未知，说明实际原因 |

previousUse还可为not_targeted/not_confirmed/superseded/unknown。暂停和新内容是否生效是两件事；提炼失败不自动撤销已确认暂停。目标不明确或发生版本冲突时不猜测修改多条。

快速完成合并一次确认，异步操作由客户端SDK带退避跟踪并更新同一显示项。宿主不支持异步显示时留在UI/CLI查询，不伪造新聊天消息。会话关闭不取消已可靠接收作业。

## Copilot 适配

首个工作宿主是Copilot CLI，P0前固定候选官方包与版本，比较统一coding-agents和专用copilot-cli中实际可用模块。官方VS Code Copilot和通用Agent Plugin的Skills+MCP能力不等同CLI生命周期hooks，见[官方核查](research/2026-09-14-agent-integration-reuse/README.md)。

官方专用插件已有会话开始召回、按轮次写回、结束保存及工具记录选项；统一包也提供会话写回、注册和日志。分别固定版本并验证覆盖后复用。LessonLoop补充真实任务身份、方法修订、完整指导与结果关联；当前适配未接通的官方能力归为接入工作。

适配复用事件解析、材料捕获、上下文回填和诊断，将原生API调用转换为产品操作。不能仅换base URL，也不预先实现整个Hindsight兼容服务。宿主若支持plugin包可沿官方格式注册；若复用独立hooks注册，则明确所有权和卸载。用户无需手工复制源码。

采集优先复用官方实现，薄适配负责授权范围、排除 LessonLoop 派生内容、方法注入和产品接口转换。当前固定 coding-agents 0.4.2 的流式读取与消息规范化，来源与差异见[采集复用](../third-party/copilot-collection.md)。每个 Copilot 会话绑定一个 taskRef；停止、退出和恢复不切分任务，也不直接决定任务结果。学习材料从 transcript 入库；回顾另接收当前用户提示与宿主停止原因，工具观察仍从 transcript 读取，不重复采集工具回调。学习与回顾分别维护检查点；回顾提交失败时保留待重试的回调材料。

Agent MCP 只公开 getGuidance、submitSource、feedback，三个工具都提供明确的参数结构。工具参数为 input 和可选 eventId；重试同一次请求时复用 eventId。可信事件使用专用宿主入口；对象详情、主题复盘、作业查询、删除、范围、导出和安装管理由 UI/CLI 提供。

getGuidance 接受 query，或 target={kind:playbook/experience,id,revision}。已有 hook 或上次返回的 taskRef 时复用该任务；首次调用可省略，核心按唯一授权范围或显式 scopeId 创建任务，并按请求幂等键复用。多范围时必须指定 scopeId；已有任务只检索自身范围，校验任务身份、结束状态与24小时时限。Copilot 会话按24小时空闲时间检查，新宿主回调刷新活跃时间；每条提示重新检索，不固定使用首次命中的方法。直接 RPC 首次调用必须携带 Idempotency-Key，MCP 适配器会补齐。

返回 taskRef、scopeId、playbooks 和 experiences；无命中仍返回任务引用。按问题查询时，内部搜索、准备至多一个方法并召回至多三条经验，保留完整步骤、条件、例外及 guidance/lead 区别。Agent 提供的 context 不作为可信执行证据。requires_expansion 返回方法引用；调用方用相同 taskRef、target 和 viewMode=expanded 展开。定向经验展开包含证据，仍检查当前使用资格，不返回已停用的原始对象详情。每次调用重新检查资格，不缓存旧指导正文。

submitSource 接收 agent/external 材料、可选补充来源引用，返回异步接收回执；回执不代表学习或发布完成，作业状态在 UI/CLI 查询。feedback 接收目标引用、修订、评价和纠错说明，记录调用者意见，不作为真实任务完成的证明。旧的分步检索和任务操作继续供核心、UI/CLI 与可信 hook 使用，不再作为 Agent MCP 工具公开。

| 能力 | 验收与限制 |
|---|---|
| taskInjection | 新任务首次规划/行动前搜索并准备方法；只配置MCP不算自动路径 |
| explicitPrepare | 显式获取完整方法与刷新当前版本可运行 |
| trustedCapture | 实际来源角色、尝试与结果可核对；工具配置存在不等于覆盖完整 |
| trustedOutcome | 声明能观察哪些检查/产物与任务结束，未观察的结果为unknown |
| asyncReceipt | 支持异步回执位置，缺少时明确使用UI/CLI查询 |

基础自动方法使用要求taskInjection、explicitPrepare和声明范围内trustedCapture。没有可观察边界的模型内部采用不承诺拦截；已有上下文文本不能收回。所有能力、失败和降级按宿主版本列出。

## 触发与配置

新任务走searchPlaybooks→preparePlaybook，必要时补直接经验；不默认叠加两份上下文。显式使用或关联工具步骤进行定向准备，关键新信息使旧判定失效；普通澄清、进度和无关工具不创建新任务。迟到、取消或被替代的响应不注入当前上下文。

任务阶段结果、结束或新资料触发有预算的复盘。后台只处理获准材料，不重复执行用户操作。学习模型调用与工作宿主隔离，避免采集自己的提炼或回顾文本。

学习、自动推荐、效果回顾、提醒以及scope配置分别存储。关闭学习停止新摄取和新自动复盘，已接收作业默认完成，可显式取消；自动推荐关闭仍可显式准备。上游历史导入、git摄取和自行更新默认值按产品配置固定，不隐式扩大范围。

## 本地效果回顾接口

listTasks按授权范围列出当前任务。getTaskFeedback({taskRef})读取当前反馈及revision；updateTaskFeedback按expectedRevision更新一个字段。field=delivered需要playbookId/revision，仅可信宿主可确认；field=taskOutcome需要taskOutcome和可选text，任务所属宿主及有该scope权限的用户可写；field=userRating需要playbookId/revision、rating和可选text，仅用户可写。结果来源由服务绑定，调用者不能自报AI或用户身份。用户确认或纠正后，AI和宿主不能覆盖该结果，包括用户填写的unknown。

字段同值重试不改revision，旧revision不能覆盖新值。清空会保留递增版本的空标记；显式重新准备可恢复登记，旧请求仍不能写入。反馈过期后不可更新。反馈更新不接收事件批次，也不重放历史。

Copilot仅在真实注入回执或MCP工具成功返回完整guidance的回执后写delivered；产品输出仍不进入学习材料。反馈版本已变化时，宿主重读记录并最多重试一次，前提是原方法版本仍有登记且回执晚于清空边界；否则保留投递未知。

可信宿主通过submitTaskOutcome提交taskRef、generation、checkpoint、observations、gaps和trigger。userPromptTransformed收集新材料，agentStop/sessionEnd将结果判断加入持久队列；这些事件本身不是成败结论。该入口只接受所属宿主与获准范围，不在Agent MCP公开。只开回顾也能处理结果材料，不创建学习来源或Hindsight bank；材料范围和保留预算见[07](07-storage-model.md)。

后台AI根据用户目标、原始观察和缺口判断succeeded/failed/abandoned/unknown，引用须与所提交观察的连续原文一致。未恢复且使目标未完成的错误可支持failed；用户明确放弃任务才支持abandoned。暂停生成、退出、超时或一次工具报错都不能直接作为结论，Agent自报完成也不够。模型不可用与任务失败分别记录，处理限制和人工入口见[11](11-post-release-evaluation.md)。

getUsageView({playbookId?})与getEffectSummary直接读取当前记录，返回结果来源，Copilot会话标注session范围。reviews.issue引用caseId和当前revision；记录更正后，问题确认降为待核实。reviews.export导出当前记录及选定的原始观察，clearEffectData清空回顾并使待处理判断失效。导出不自动上传或启动开发Agent。

## Connector 接口

Connector 输入为 source、experience_draft 或 playbook_draft；source 可携带原文或结构化工作记录，全部进入相同核心规则。来源更新、append/correct、游标及删除合同由[08](08-connectors.md)维护，Connector 不能直接授予发布资格。
