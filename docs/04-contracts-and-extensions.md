# 接口与扩展

日期：2026-09-14。状态：待实现的应用接口与宿主合同，方法名不是厂商 SDK 的原生参数。领域语义见[经验模型](02-experience-model.md)，持久字段见[数据模型](07-storage-model.md)，安装与组件更新见[发布设计](10-distribution-and-installation.md)。

## 调用边界

本地服务提供带版本号的 API，供 CLI、MCP 和界面调用。principal、grantedScopes、adapterIdentity 来自本地认证及配置，不能由模型生成。首期虽然只有本机单用户，服务仍须验证令牌与授权范围，不开放未认证端口。

用户用 scopeId 组织知识并授权访问，例如 `project:alpha`、`personal:engineering`。applicability 和条件另行表达适用领域、流程、工具或 repo/branch。Copilot 可绑定项目集合与已授权的通用集合，但不会把采集时的分支自动写成限制。

跨集合发布按新 proposal 检查依据和脱敏，不能继承私有来源的 supported/active。首版 derivedFrom 只允许同 scope 引用。

## 核心操作

| 操作 | 输入 | 输出与关键行为 |
|---|---|---|
| `submitMaterial` | scope、材料片段、可选目标主题或 verificationFor={id,revision} | jobId；材料已接收不等于经验已发布或验证；补证目标须同 scope 且已授权 |
| `getJob` | jobId | 作业状态、准入结果与当前 receipt；completed 不代表新规则生效，当前性须重读核验 |
| `recall` | query、scopeIds、当前 context、可选筛选/includeLeads/target/contextEvidence | guidance 或 lead 及当次判定；complete/partial/unavailable，线索不改变经验状态 |
| `browse` | scope、筛选、可选 query/field、cursor | 显式调查可查 exceptions 和可见 held/disabled；不自动注入，cursor 绑定范围/筛选 |
| `inspect` | experienceId | 当前字段、摘录、依赖、assessment、有效期及 review 原因/问题/期限；不承诺历史正文 |
| `revise` | id、expectedRevision、具体变更或纠正文本 | jobId+receipt；快速完成也用同形响应，可含结果修订；冲突不覆盖 |
| `setState` | id、expectedRevision、active/disabled | 停用优先；active 是重新启用请求，服务重跑准入，不能直接强制信任 |
| `remove` | id 或本人可管理的来源 fingerprint | 先停止使用，返回清理任务；全部清理后才完成 |
| `feedback` | id、targetRevision、helpful/irrelevant/incorrect、可选 correctionText/任务条件 | 相关性反馈不直接改事实；纠正返回 jobId+receipt，明确目标停止投递后再报暂停 |
| `consolidate` | scope、可选主题、预算 | 对有限邻域比较与提炼的作业 |
| `export` | scope、格式 | 完整结构化当前经验和可用来源；不导出秘密账号信息 |

verificationFor 用于关联经验主张的补证。本次任务条件的确认使用 recall.target 和更新后的 context，不产生长期支持。服务须核对补证与目标主张、修订的关系；目标已变时不能自动激活新版。这个字段不授予执行权限、来源角色或 verified 状态，role=tool 仍须由可信宿主绑定。

首版 MCP 只提供 recall、inspect、submitMaterial 和 feedback。删除、范围管理及完整导出由 UI 或 CLI 操作，所有入口调用同一服务实现。

服务负责 expectedRevision 检查、写协调和未知结果隔离，调用方不能绕过核心直写引擎。后端实现及 Mem0 原型的限制见[架构](03-architecture.md)。

## 材料与提取 proposal

以下示例不含 eventId、sessionId、repository 或邮箱字段。数组下标只在该次提取请求中绑定来源。

服务按接入通道确认来源角色。可信 SourceAdapter 可以绑定宿主提供的角色，普通 MCP 中填写 user/tool 则不足以证明是用户原话或工具观察。认证用户手动提交的外部引文仍保留 external 归属。excerpt 校验只检查引文一致，不能验证角色。

```json
{
  "scopeId": "project:alpha",
  "segments": [
    {
      "text": "运行生成命令后，src/client 的手工修改被覆盖。legacy/client 是手写代码，不经过这个步骤。",
      "role": "tool",
      "locator": "workspace://alpha/build-notes"
    },
    {
      "text": "修改生成客户端的契约时，先修改 schema，再重新生成客户端。",
      "role": "user"
    }
  ]
}
```

此处 URI 是说明性位置，不是实际运行证据。真实调用只能使用存在的位置。模型提交 proposal 时用 `segmentIndex` 与原文 `excerpt` 指向材料；服务验证后转换为带归属的 evidence。未经验证的 URL 不能作为已经读过的材料。

材料、片段和 proposal 的容量统一见[管理记录合同](07-storage-model.md#管理记录的最小合同)。超限返回 `input_too_large`，不自动截断。

扩展按主题分片并保留完整语义，相关材料可在任务结束前后继续补充。首期不承诺在这些限额内完整提取长文知识，分片是否漏学须另行评测。

经验存储语言默认英文：conclusion、conditions、exceptions 和规范化主题使用英文，原文 evidence 保持原语言，代码/参数保留原样。该默认可配置；检索应同时验证中文提问与英文经验。产品文档和用户界面语言不由经验存储语言决定。

## 查询与结果

```json
{
  "query": "修改这个客户端接口",
  "scopeIds": ["work:engineering"],
  "context": {"code.repo": "project-b", "code.path": "src/client/orders.ts"},
  "includeLeads": true,
  "limit": 3
}
```

下列字段只用于请求、响应或消费端任务缓存，不写入 Experience 或后台管理记录。

| 字段 | 形状与限制 | 用途 |
|---|---|---|
| recall.query | string，最大 4 KiB | 当前任务或查询目标 |
| recall.scopeIds | 最多 8 项，每项最大 128 B | 请求集合，与调用身份授权求交 |
| recall.includeLeads | boolean，可选，默认 false | 明确要求并能够处理线索 |
| recall.target | 可选 {id, revision}，id 最大 128 B，revision 为正安全整数 | 精确重评当前项，不跳过 query/scope/context 与资格检查 |
| recall.context | 0–32 个命名空间 key；key 最大 64 B，每值最大 128 B，可为最多 4 项数组 | 本次环境信息，与材料 context 形状相同，不授权 |
| recall.contextEvidence | 最多 4 项 {keys,excerpt,role,locator?}；keys 为 1–4 项，excerpt 最大 512 B，locator 最大 256 B | 本次可核验材料，沿用真实通道归属规则 |
| item.usage | guidance/lead，必填 | 可采用经验或待核实线索 |
| item.taskApplicability | applicable/undetermined，必填 | not_applicable 只作内部判定或定向空结果原因 |
| item.relevanceReason | lead 必填，1–256 B | 具体说明任务关联，相似分数不能代替 |
| item.missingChecks | lead 必填，1–4 项 {field,index,question,contextKey?}；question 最大 256 B | field 为 conditions/exceptions，index 是目标修订数组下标；不含执行命令 |

完整 recall 请求 JSON 最大 16 KiB，包含所有参数。超限返回 `request_too_large`，不截断材料或填补未核实值；Material 与 Experience 的容量独立计算。

context 描述当前任务，授权范围仍由 scopeIds 与调用身份求交得到。code.repo、branch 等使用绑定宿主提供的值，模型不得覆盖。缺失值保持缺失；补充上下文须来自本次用户说明或实际读取、观察，不能靠名称猜测、沿用历史上下文或填写“已验证”。

contextEvidence.keys 只说明涉及哪些值，role 仍由通道核验。服务还须核对材料对应的对象、版本、当前性和断言；材料不足或有冲突时仍为 unknown。

事实性 context 值须由可信宿主绑定，或有足够的 contextEvidence 支持。用户原话可以确定本次任务类型和意图；关于工具行为的断言仍要核验。片段只用于本次请求或任务的短期评估，不写入 Experience，也不累计为来源支持。

默认使用 semantic。exact 匹配完整实体值，field 对 conclusion/conditions 等正向字段做词项过滤；mode 不决定结果属于 guidance 还是 lead。exceptions 统一用 browse(query, field=exceptions) 调查，不注入自动上下文。recall 不支持该字段，也不增加第三种 usage。

includeLeads 默认 false。客户端须保留 usage 和缺口含义，并实现先核实后采用，才能开启。官方 Copilot plugin 也必须先通过协议验收；只理解结论文本的客户端继续只接收 guidance。

| 逐项判断结果 | 返回行为 |
|---|---|
| 资格有效、任务相关、条件全部满足且例外均排除 | taskApplicability=applicable，usage=guidance |
| 资格有效、任务高度相关、无已知不满足，但缺少明确可核实的当前信息 | taskApplicability=undetermined；includeLeads=true 才返回 usage=lead |
| 已知必要条件不满足或任一例外成立 | 不返回条目；定向重评可给 not_applicable 原因 |
| 持久 applicability=unknown，或 held/disabled/过期/来源失效/无权限 | 不通过自动资格，不能改成 lead |

响应包含 items、status、mode、reason。每项给出 id、revision、purpose、结论、applicability、条件、例外、basis、assessment、有效区间、usage、taskApplicability、匹配字段及来源数量。lead 另外提供简短 relevanceReason 和 missingChecks。检查点引用当前修订中 condition/exception 的数组索引，附 question 和可选 contextKey，只提出问题，不给待执行命令。

默认最多返回 3 项、约 800 token，其中 lead 最多 1 项。先放 guidance，余下预算不足就不放线索。条件、例外、依据标签、usage 和核实问题必须完整，放不下便减少条目；未知项超过 4 个或无法完整表达时不返回 lead。guidance 的 missingChecks 为空或省略。evidence 正文通过 inspect 查看。

以下是响应条目的示意，ID 为示例；实际响应仍包含前述条件、例外和依据字段：

```json
{
  "id": "example-memory-id",
  "revision": 3,
  "usage": "lead",
  "taskApplicability": "undetermined",
  "relevanceReason": "任务涉及客户端文件变更，经验覆盖生成产物的修改流程。",
  "missingChecks": [
    {
      "field": "conditions",
      "index": 0,
      "question": "当前文件是否由生成流程维护？",
      "contextKey": "artifact.kind"
    }
  ]
}
```

## 核实后定向重评

Agent 先确认当前任务权限和剩余预算是否允许核实，再读取相关配置、标记等。missingChecks 不授予新权限，也不能作为命令执行；不必为每条经验重跑完整测试。

```json
{
  "query": "修改这个客户端接口",
  "scopeIds": ["work:engineering"],
  "target": {"id": "example-memory-id", "revision": 3},
  "context": {
    "code.repo": "project-b",
    "code.path": "src/client/orders.ts",
    "artifact.kind": "generated"
  },
  "contextEvidence": [
    {
      "keys": ["artifact.kind"],
      "excerpt": "This file is generated. Do not edit directly.",
      "role": "tool",
      "locator": "workspace://project-b/src/client/orders.ts"
    }
  ],
  "includeLeads": true,
  "limit": 1
}
```

示例来源必须由实际宿主读取并绑定；普通 MCP 填写 role=tool 不使它成为工具事实。一次标记检查只支持它实际表达的条件，其他未核实例外仍为 unknown。核心重跑门槛与全部条件，返回 guidance/lead/不适用之一，不接收调用方自报的 applicable 布尔值。

指定 target 时仍须提供当前 query、scopeIds 和 context，context 可以为空。target 只负责精确找到待重评项，不跳过相关性或条件检查。

先检查授权、active/合法依据、有效期、来源/依赖和写屏障。目标不存在或任一检查失败时，统一返回 items=[]、reason=target_unavailable。全部通过后才比较 revision；已变则返回 target_changed，客户端丢弃旧 missingChecks，再按当前版本召回。变更提示不能泄露失效或隐藏内容。

同一真实用户任务对同一经验最多核实两轮，只有新信息才继续。重复 recall、重排缺口或修订变化都不重置预算。缺权限、工具出错、无增量或预算用尽时停止，不能改报 guidance。次数只存在消费端短期任务缓存；重启丢失后不自动续查旧线索。

一轮指为回答缺口执行一组有界检查并提交一次重评；采用前仅刷新记录/权限、复用仍有效上下文，不算新取证轮次，也不得借刷新触发额外无预算检查。两轮限制按同一经验 ID 计，不按问题文字或返回顺序计。

采用经验开始新的动作前，官方适配应定向刷新当前记录与仍成立的上下文；repo、branch、对象、版本或用户约束变化立即废弃当次判定。核心只保证响应组装时的当前性，不宣称能收回已送入代理的文本。刷新失败则不用旧缓存继续取得指导资格。

当次重评不改变 Experience、revision、assessment 或有效期。只有发现针对经验主张的新支持、反例或条件时，才通过 submitMaterial(verificationFor={id,revision}) 提交材料并重新准入。本次不适用、一次成功或工具报错都不自动触发全局修改、删除。跨 scope 的材料先按发布和脱敏规则处理。

`reason` 保留 no_match、not_applicable、applicability_unknown、dependency_pending、budget_exhausted、storage_unavailable、provider_unavailable，并增加 target_changed/target_unavailable。applicability_unknown 指无法定为 guidance；可以伴随一条合格 lead，也可以没有可用线索。response 不披露无权限候选被筛掉的详情。

irrelevant 表示本次任务不相关，不全局停用经验。helpful 用于分析本次收益，不增加因果支持、升级 assessment 或自动延长有效期；重复投递和模型复核也一样。

incorrect 必须带 targetRevision。目标已变时返回版本冲突，避免误停新修订。真实用户明确指出经验错误后，服务先持久化目标屏障，再生成带 review 的 held 修订并处理 correctionText。临时例外不当作错误；本人改变偏好按新意图修订，事实纠正则核对依据。代理怀疑只形成待检查反馈，不能冒充用户授权；实质矛盾按证据策略暂停建议。

首版只保留有限诊断采样和开发评测统计，不保存完整的逐次投递事件日志。

可信宿主适配可以捕获用户原话，绑定当前上下文中的经验 ID/修订后直接调用 revise。没有这项能力时，通过 MCP feedback 提交 correctionText 和目标修订，核心按代理转述处理。目标不唯一时先接收材料，再让用户选择目标，不猜测或一次修改多条。

保留意图、事实支持和临时例外按[准入规则](02-experience-model.md#准入先判断是否该记再判断能否用)分别判断；对用户的进度确认按以下回执合同生成。

## 纠正回执与展示时机

收到用户纠正后，先区分针对某条已存经验的实质纠错、本人改变长期要求，以及当前任务的临时例外。目标必须明确、版本未冲突、归属可信，才按相应路径暂停或修订。临时例外不暂停长期经验；普通 MCP 代理转述不能自报“已替用户停用”。

| 用户反馈阶段 | 服务确认条件 | 展示示例 |
|---|---|---|
| 已收到纠正 | 脱敏输入与处理作业已可靠保存，返回稳定 jobId | “已收到，正在处理这条经验。” |
| 旧建议已暂停 | 已明确目标及其修订，暂停屏障或 held/disabled 当前状态已确认，旧版不再通过投递门槛 | “旧建议已暂停，更新完成前不会继续推荐。” |
| 新规则已生效 | 目标新修订通过准入，发布内容与实际后端的必要检索写入均确认并读回，索引字段可读，相关写屏障解除，当前自动资格与有效时间通过 | “已更新：项目使用 pnpm，legacy/ 仍使用 npm。” |
| 尚未生效或无需保存 | 缺证据、目标不明、被判临时、未来才生效、处理失败或结果未知 | 明确说明原因和旧目标是否仍暂停，不使用“已记住” |

“已生效”表示该修订现在可以参加正常召回。它是否适用于当前任务，仍要判断 guidance/lead 并在采用前刷新，也不保证所有查询都会命中。只有 add 返回值、写操作 acknowledged、job completed 或 held 记录时，不能报生效。

revise/corrective feedback 的写响应与 getJob 从短期作业、写操作和当前经验生成 receipt。helpful/irrelevant 不产生更新回执，也不单独保存通知流。字段合计最多 2 KiB，错误原因最多 512 B；正文从当前授权记录读取。

| 字段 | 形状 | 语义 |
|---|---|---|
| accepted | boolean | true 仅表示输入可靠持久化；作业到期后无法查询不能反推未接收 |
| target | 可选 {id,revision} | 已明确的被纠正版本；歧义或无权限时不捏造或泄露目标 |
| previousUse | not_targeted/not_confirmed/suppressed/superseded/unknown | 无旧目标、未确认暂停、指定旧版不可投递、被后续版本替代、当前无法确认 |
| replacement | {status,id?,revision?} | status=pending/effective/not_effective/unknown；id/revision 来自已登记结果 |
| reason | 可选短代码与说明 | 如 awaiting_evidence、temporary_only、target_ambiguous、version_conflict、failed、scheduled、updated_again |

几个字段分别表达事实，不要求每次依次显示三个阶段。suppressed 只表示指定旧版当前不能投递，不表示所有替代经验都停用；已确认暂停而更新失败时，可同时为 suppressed 和 not_effective。新增经验没有旧目标，快速完成的替换也可省去单独的暂停消息。

旧建议的暂停只有经服务确认后才能回报。接收后到执行暂停之间若目标修订已改变，先按 expectedRevision 处理冲突，不影响新修订。未确认的屏障写、目标歧义或版本冲突时，最多说输入已收到；新提炼失败不会自动撤销已经确认的暂停。屏障仍有效时可说“旧建议保持暂停，新内容尚未生效”。暂停不代表能回收已经进入其他代理上下文的旧文本。

快速完成时合并成一次带实际结论和范围的最终确认。未立即完成时，显示一条接收/暂停的进行中状态，最终更新为生效或未生效；不机械弹出三条消息。没有明确用户纠正的普通后台提炼只更新 UI 学习状态，不逐条打断会话。

官方适配通过客户端 SDK 跟踪 job，以有上限、带退避的 getJob 查询更新状态，无需模型主动轮询。按 jobId 和短期请求序号采用最新 receipt，丢弃过期、取消或被新请求替代的响应；同一 job 更新原显示项，不重复通知。

会话存在时使用宿主支持的回执位置。宿主无法异步显示时，结果留在 UI/CLI 中供查询，并说明限制；不能伪造聊天回复或启动新 Agent 补发。

getJob 每次按当前权限、目标版本、来源/依赖、状态和有效期生成回执，不能沿用历史 completed 宣布生效。后续已修订、停用、删除或过期时，报告 updated_again/unavailable 等原因，不显示隐藏内容。网络不可用就说明无法确认当前状态。

关闭会话或 UI 不取消已接收作业。作业记录到期后仍可查询当前经验，但不能重建不存在的通知历史。

## 扩展能力

AgentAdapter 对接代理会话，可实现 SourceAdapter、ConsumerAdapter 或两者，Copilot plugin 属于此类。Connector 对接长期外部来源，提供增量读取、转换与来源变化；ConnectorRuntime 统一处理定时、重试、接收确认和游标。[持续同步合同](08-connectors.md)定义拉取与认证推送。ExtractionModel 单独提供模型推理，与来源接入独立。

扩展清单声明 id、版本、输入能力、可用范围及可选条件评估能力。首期使用显式注册模块，无需插件市场、自动发现总线或热加载框架。持久同步状态由核心管理，凭据使用系统凭据设施，插件不能直接读写数据库。卸载接入后既有经验仍可查询，是否删除由用户明确选择。

### Copilot 适配

Copilot 接入以 GitHub Copilot CLI plugin 目录或包随 LessonLoop 发行组件交付，由统一 setup/agent 命令注册，用户不必从源码复制脚本。首期不提供 VS Code VSIX 或替代代理。按 Agent Plugins 1.0 格式组织：plugin.json、mcp.json 和 skills/ 放根目录，Copilot hooks 放 com.github.copilot/hooks/。manifest 和 hook 事件须在固定 CLI 版本上验证，官方文档列出支持项并不等于采集已完成。

插件包含以下内容：

- 插件清单：名称、版本、组件声明及安装说明。
- hooks 与短时脚本：接收实际支持的宿主信号，组织材料、传递上下文与用户纠正；不在 hook 中执行耗时提炼。
- MCP 配置及 stdio bridge：暴露 recall、inspect、submitMaterial、feedback，转发到同一个核心 HTTP 服务。
- 必要的 skills：说明 guidance/lead、验证权限和结果分流；用途保留、预算与状态刷新由适配代码和实际运行验收保证，不只依赖提示词。
- 适配配置与诊断：核心连接、授权集合映射、能力检测、超时与兼容版本检查。

插件通过用户安装目录中的稳定 launcher 启动 bridge/脚本，locator 解析当前兼容版本，不把 versions/<version> 硬编码到宿主配置。插件不包含另一套记忆引擎或经验生命周期。核心未运行时返回明确不可用，不把每次 MCP 启动变成创建新核心进程。卸载插件只移除宿主接入，应用卸载和数据清理分别处理。升级后旧进程需要宿主重载时明确报告，不承诺热切换。

Copilot 适配负责宿主接入、短时排队、超时取消和上下文格式，将可用内容映射到通用材料接口。宿主事件只用于采集与关联，不成为核心材料的必填字段。

| 能力 | 适配职责 | 验收边界 |
|---|---|---|
| 内容采集 | 将用户纠正、调查摘录、工具结果组成材料 | 缺失内容不能伪造；不能把 agent 总结伪装为用户声明 |
| 原生重复处理 | 用宿主原生标识短期去重或关联 | 标识只在适配私有状态；核心不需要长期 eventId |
| 工作范围 | 根据可信工作目录与配置映射集合 | 未绑定时提示配置，不扩大到全库 |
| 任务召回 | 新任务开始自动召回，关键新信息/目标变化按需补召回 | 固定版本验证发生在规划/行动之前；MCP 可调用不算自动回填通过 |
| 上下文注入 | 保留 guidance/lead 用途、条件/例外与依据；lead 说明缺口 | 线索不得直接当执行指令，不能覆盖当前指令或权限 |
| 线索核实 | 任务缓存计数、授权内检查、携更新上下文定向 recall | 最多两轮且有新信息；失败不采用、不全局删除经验 |
| 采用前刷新 | 新动作前复核目标修订与当前上下文 | 陈旧/不可用结果不能靠本地缓存继续取得资格 |
| 纠正 | 绑定明确目标，提交并跟踪服务 receipt | 区分已接收、旧目标已暂停和新修订生效，不要求用户查内部 ID |

首版模型默认复用现有 Copilot SDK 登录和订阅，无需独立模型 API key；它与工作代理 Copilot plugin 是两个独立接入。Hindsight 已有 github-copilot provider，Mem0 路线需要对应模型适配，不能混为同一种内置支持。模型调用使用同用户的正常认证并与采集 hooks 隔离；截止时间、取消和有效参数按 provider 实际能力报告，登录不可用时保留待处理作业并提示修复。

### 自动召回触发表

这是产品行为契约，具体宿主 hook 名称、载荷和回填通道必须在固定 Copilot CLI 版本上验证。不能从“支持 hooks/MCP”直接推断以下时机已经实现。

P0 已在隔离 CLI 1.0.83 中用脚本模型观察到两种 prompt hook 在首次请求前回填，明确 preToolUse deny 阻止测试读取；但 preToolUse 超时继续放行。该行为不能构成服务失联时自动阻止操作的保证，需适配的显式控制和实际模型配合测试。详情及官方说明差异见[宿主实测](research/2026-09-13-p0/README.md)，不据此宣布完整自动召回或回执体验已完成。

| 时机 | 调用与处理 | 是否重新搜索全部候选 |
|---|---|---|
| 新的用户任务开始 | 已获得任务目标与可信宿主上下文后，自动 recall，并在 Agent 首次规划/行动前回填 | 一次有界候选检索，应用正常3项/800 token/1lead预算 |
| 即将采用已召回经验开展相关动作 | 使用 target.id/revision 和当前 context 定向刷新 | 否，仅刷新将被采用的项；无关工具调用不触发完整搜索 |
| 获得影响条件的关键新信息 | 废弃受影响的当次判定，target 重评；若发现新的问题主题，可补一次候选召回 | 先定向，必要时补召回，合并相同输入触发 |
| 用户明显改变任务目标/约束 | 更新任务上下文，丢弃不适用结果，按新的目标补召回 | 必要时有界检索，不因普通澄清重置线索核实预算 |
| 模型主动调用 MCP | 深入搜索、inspect、线索重评或反馈 | 作为自动路径的补充，仍遵守权限与预算 |

首条实质请求或明确的新工作目标触发开始召回。工具事件、模型轮次、进度确认，以及当前任务的补充或纠正，都不自动创建新任务。任务关联和输入指纹只在消费端短期去重。无法确定目标是否改变时，沿用当前任务预算，按新信息补召回。

在途 recall 绑定调用时的任务、上下文快照和内存请求序号。请求取消、超时、被新请求替代，或用户切换目标、目录、分支、对象后，迟到响应一律丢弃，必要时重发。序号不持久化，重复 hook 和相同输入合并，避免重复注入上下文。

开始召回只等到规定截止时间，不在 hook 中等待后台提炼或验证。超时或服务不可用时，宿主继续原任务并显示召回不可用，不能说已经参考了经验。动作前 target 刷新失败后不得使用旧缓存；宿主可按原任务已有依据决定是否继续。

安装诊断分别检查任务开始回填、采用前刷新、可信材料捕获与异步回执能力。缺少某项时报告具体限制；只有模型主动调用 MCP 的配置标为“仅工具调用”，不算首版自动使用验收通过。所有能力的失败处理均不扩大宿主权限。

### 持续同步 Connector

Connector 支持原始材料和现成 experience_draft，后者仍须核心校验归属、条件与证据，不能导入外部 active/supported、用户角色或内部 ID。受信 Connector 调用 ingestChanges，普通 MCP submitMaterial 不获得同步控制权限。

ConnectorRuntime 管理连接实例、调度、限流、背压及接收和学习进度。输入可靠接收后才推进外部游标，提炼结果另行报告。来源变化、删除和权限撤销使用统一的来源控制，外部协议和对象键只留在同步映射里。

UI/CLI 提供添加、检查、立即同步、暂停/恢复、状态、重新认证与移除。邮件、文档目录、知识库或复盘系统只是实例，具体实现按需交付。暂停停止新采集，已接收学习默认继续；移除默认保留经验。完整合同以[Connector 持续同步](08-connectors.md)为准。
