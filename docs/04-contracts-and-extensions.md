# 接口与 Agent 接入

日期：2026-09-15。状态：当前应用合同，主要接口已有实现，剩余差距见[13](13-implementation-plan.md)；操作表包含尚未开放的目标接口。方法名属于 LessonLoop API，字段与容量见[07](07-storage-model.md)。

## 调用原则

UI、CLI、AgentAdapter 与 Connector 使用同一带版本核心 API。认证身份、授权 scope 和适配能力由服务配置确定，模型不能填写身份字段取得权限。所有修改检查 expectedRevision，写结果未知时返回 uncertain，不把 jobId 当作发布成功。

ObjectRef={kind,id,revision} 用于跨对象结果、反馈、纠正和回执。单对象入口可使用 methodId 或 caseId，但存入控制和作业时恢复完整类型。scopeIds 与调用者授权求交，知识主题和 context 不扩大访问范围。

## 输入与学习操作

| 操作 | 主要输入 | 输出与行为 |
|---|---|---|
| submitMaterial | scopeId、segments、可选context/caseFor/verificationFor | material/job引用，可靠接收后回报；未形成案例也可提炼经验 |
| submitWorkCase | 与submitMaterial相同的scopeId/segments，可选caseFor | 复用材料接收及案例综合，返回material/job引用；案例修订在作业通过后形成 |
| appendCaseResult | scopeId、caseId/expectedRevision、segments；请求幂等键 | 转为submitMaterial.caseFor，保留原案例/任务关联及旧观察；实际纠正须指定目标 |
| reviewTopic | scopeId、topic | 在当前有界材料中创建复盘作业，不执行真实任务 |
| getJob | jobId | 当前阶段、产出ObjectRef、处置与回执；正常完成可以零产出 |
| cancelJob | jobId | 停止未发的新步骤；已发原生操作须确认，不能伪报取消成功 |

普通 MCP 提交按实际 agent/external 归属保存。可信宿主才可绑定 user/tool 原文，验证 excerpt 相同不等于验证来源角色。补证目标必须同 scope、当前修订且可访问；新事实来源不能自动变成本次任务的事实，反向也一样。

首版内部规范化经验和方法默认英文，可配置；原文保留原语言，UI 可以中文显示。翻译不改来源或自动产生新领域修订，中英召回单独验收。

## 方法库操作

| 操作 | 行为 |
|---|---|
| searchMethods | 按query和授权范围内scopeIds检索已发布方法摘要；当前条件在prepare中核对 |
| browseMethods | UI/CLI按scope、状态、主题、query和cursor分页查看有权限的active/held/disabled方法；不自动注入，cursor绑定筛选范围 |
| pinMethod | 用户按id/pinned保存常用标记，不改变方法正文或发布修订 |
| inspectMethod | 查看当前方法、步骤、来源和状态，可查看有权限的暂停项 |
| methodHistory | 查看仍保留的旧版与变化，缺失内容明确标注 |
| prepareMethod | 为任务返回完整方法指导，见下节 |
| reviseMethod | 修改目标、步骤、条件或纠正说明，通过准入和写协调形成新修订 |
| setMethodState | active/disabled请求；重新启用仍核对依据，不强制跳过准入 |
| removeMethod | 先停止投递，再清理当前、旧版和投影；默认保留仍有用途的基础经验 |
| exportMethod | 输出Markdown/checklist/skill快照，预览范围和版本，不安装或执行 |

用户约束、来源删除和方法纠正不允许通过原生 UI 或工具绕过产品控制。核心可复用官方管理实现，但产品修改必须保留自己的版本和意图。

## 方法使用与结果回传

prepareMethod 输入 methodId/revision、taskRef，可选 requestId 和 viewMode=auto/expanded。一次返回完整指导，无需提交步骤完成记录或调用 reassessTask；该旧接口已移除。taskRef 由核心创建并绑定调用身份，不能用任意字符串冒充其他任务。UI 可选择当前有权访问的同范围宿主任务。

核心核对任务身份、范围、结束状态和期限，以及方法当前修订、发布状态、有效期、来源和支持经验。工作 Agent 根据现场信息判断全局条件、例外和分支。搜索相关不等于本次适用，指定方法也必须检查这些边界。

| 准备结果 | 含义与返回 |
|---|---|
| guidance | 完整条件、步骤/分支、全部检查及其stepIds、executionBoundary、ObjectRef、methodUseRef；不宣称本次已适用或完成 |
| target_changed | 旧revision过期，丢弃旧视图后重新准备 |
| target_unavailable | 不存在、无权或资格失效；不泄露隐藏详情 |
| requires_expansion / too_large | 自动预算不足可显式expanded；显式上限仍不足则不提供残缺视图 |
| unavailable | 引擎、存储或核对失败；不能当作“没有相关方法” |

Agent 从第一个步骤开始，无 choices 时继续下一步；有 choices 时完成该步骤，再根据当前观察选择唯一匹配的 next 或 stop。条件缺失、无匹配或多匹配时调查或询问。完整展示所有分支便于理解，执行时只走所选路径，并应用全局及该路径绑定的检查。执行后才能得知的结果须来自本轮实际操作，不能用旧结果代替。

prepareMethod 不维护内存执行会话，不保存当前步骤或分支补查次数。每次获取都重查当前资格；核心重启后，未结束且未过期的任务仍可获取方法。methodUseRef 按任务归属、任务和方法修订稳定生成，仅关联反馈，不是执行凭据。相同调用身份重复获取不重复记录使用，也不重置已有结果。

学习或回顾开启时保存轻量方法返回关联，学习复盘可将其带入 WorkCase.methodUses，回顾单独记录投递、实际观察及用户评价。返回或投递方法不证明采用和成功；缺少对应依据时保留 unknown。工具结果采集和后台复盘独立于方法获取。

## 直接经验操作

recall、browse、inspect、revise、setState、remove 用于 Experience。recall 同样在资格过滤后限额，返回guidance或lead；browse/inspect可显式查看有权限的held/disabled项，不转为自动指导。semantic、exact实体和field检索能力分别声明，exceptions字段只供browse调查。

recall输入query、scopeIds、context，可选includeLeads、target={id,revision}和contextEvidence={taskRef,observationIds?}。补查只引用核心保存的宿主观察，绑定目标修订并核对观察变化；普通context不能自授可信身份。线索列出条件/例外的具体缺口；补查后定向重评，不将当次适用性永久写回。跨scope材料不能自动用于修改原范围的经验。

经验revise({id,expectedRevision,correctionText})复用用户incorrect反馈，先暂停，再通过verificationFor补证审查；不直接把用户改稿当已验证事实。

feedback输入ObjectRef、helpful/irrelevant/incorrect和可选correctionText。helpful是评价，irrelevant是本次不相关，均不直接增加事实支持。可信用户明确纠错可先暂停指定旧版；代理怀疑形成待检查反馈，不冒领用户修改意图。

## 纠正回执

所有修改和getJob根据当前事实生成receipt，不复用历史completed宣称仍有效。回执字段统一为accepted、target ObjectRef?、previousUse、replacement、reason。

| 回执 | 服务确认条件 |
|---|---|
| accepted=true | 输入及作业可靠持久化 |
| previousUse=suppressed | 明确旧对象及修订，产品屏障已生效，旧版不再投递 |
| replacement.status=effective | 新ObjectRef当前通过准入，产品与投影一致且必要索引确认，写屏障解除 |
| pending/not_effective/unknown | 未完成、依据不足、临时要求、冲突或结果未知，说明实际原因 |

previousUse还可为not_targeted/not_confirmed/superseded/unknown。暂停和新内容是否生效是两件事；提炼失败不自动撤销已确认暂停。目标不明确或发生版本冲突时不猜测修改多条。

快速完成合并一次确认，异步操作由客户端SDK带退避跟踪并更新同一显示项。宿主不支持异步显示时留在UI/CLI查询，不伪造新聊天消息。会话关闭不取消已可靠接收作业。

## Copilot 适配

首个工作宿主是Copilot CLI，P0前固定候选官方包与版本，比较统一coding-agents和专用copilot-cli中实际可用模块。官方VS Code Copilot和通用Agent Plugin的Skills+MCP能力不等同CLI生命周期hooks，见[官方核查](research/2026-09-14-agent-integration-reuse/README.md)。

官方专用插件已有会话开始召回、按轮次写回、结束保存及工具记录选项；统一包也提供会话写回、注册和日志。分别固定版本并验证覆盖后复用。LessonLoop补充真实任务身份、方法修订、完整指导与结果关联；当前适配未接通的官方能力归为接入工作。

适配复用事件解析、材料捕获、上下文回填和诊断，将原生API调用转换为产品操作。不能仅换base URL，也不预先实现整个Hindsight兼容服务。宿主若支持plugin包可沿官方格式注册；若复用独立hooks注册，则明确所有权和卸载。用户无需手工复制源码。

首版MCP公开submitMaterial、submitWorkCase、reviewTopic、getJob、searchMethods、prepareMethod、inspectMethod、recall、inspect、feedback。可信事件追加使用专用认证入口；删除、范围、导出和安装管理留在UI/CLI。原生引擎工具、凭据和自动知识页不得成为未控制的另一条路径。

| 能力 | 验收与限制 |
|---|---|
| taskInjection | 新任务首次规划/行动前搜索并准备方法；只配置MCP不算自动路径 |
| explicitPrepare | 显式获取完整方法与刷新当前版本可运行 |
| trustedCapture | 实际来源角色、尝试与结果可核对；工具配置存在不等于覆盖完整 |
| stepToolRefresh | 可选增强：工具动作能关联methodUseRef/stepId并在开始前刷新，失败不重新取得旧资格 |
| trustedOutcome | 声明能观察哪些检查/产物与任务结束，未观察的结果为unknown |
| asyncReceipt | 支持异步回执位置，缺少时明确使用UI/CLI查询 |

基础自动方法使用要求taskInjection、explicitPrepare和声明范围内trustedCapture。没有可观察边界的模型内部采用不承诺拦截；已有上下文文本不能收回。所有能力、失败和降级按宿主版本列出。

## 触发与配置

新任务走searchMethods→prepareMethod，必要时补直接经验；不默认叠加两份上下文。显式使用或关联工具步骤进行定向准备，关键新信息使旧判定失效；普通澄清、进度和无关工具不创建新任务。迟到、取消或被替代的响应不注入当前上下文。

任务阶段结果、结束或新资料触发有预算的复盘。后台只处理获准材料，不重复执行用户操作。学习模型调用与工作宿主隔离，避免采集自己的提炼或回顾文本。

学习、自动推荐、效果回顾、提醒以及scope配置分别存储。关闭学习停止新摄取和新自动复盘，已接收作业默认完成，可显式取消；自动推荐关闭仍可显式准备。上游历史导入、git摄取和自行更新默认值按产品配置固定，不隐式扩大范围。

## 本地效果回顾接口

listTasks按用户授权范围列出当前任务供页面关联。rateMethodUse({taskRef,methodUseRef,rating,text?})仅接收真实用户评价，检查已返回的方法引用、回顾开关和清空边界；用户不能通过recordTaskObservation冒充宿主事件。

recordTaskObservation是可信适配专用批量入口，事件包含eventId、taskRef、kind、occurredAt、可选responseRef/methodUseRef/ObjectRef/stepId和短证据。kind包括task_started/task_ended/delivery/usage/outcome/user_rating/collection_gap。核心按真实通道确定known/unknown，不能由模型赋值获得可信身份。

相同事件ID与相同内容为duplicate，不同内容为conflict；逐项accepted/rejected/retryable，重试只处理未确认项。任务结束不表示成功，结果迟到窗口由07定义。学习与回顾独立授权，同一原始事件去重后可分别路由，标签不直接触发知识升级。

UI/CLI使用listEffectCases、inspectEffectCase、reviewEffectCase、getEffectSummary、exportEffectCases、clearEffectData；WorkCase查看使用inspectWorkCase，避免两个案例概念混用。开发导出需选择范围、脱敏预览和本地路径，不自动上传或启动开发Agent。

## Connector 接口

Connector使用checkConnection、readPage、normalize、ingestChanges及管理操作。输入可为Material、WorkCase、Experience draft或Method draft，全部进入相同核心规则。来源更新、append/correct、游标及删除合同由[08](08-connectors.md)维护，Connector不能直接授予发布资格。
