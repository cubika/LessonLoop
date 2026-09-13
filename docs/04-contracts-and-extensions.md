# 接口与扩展

日期：2026-09-13。以下为应用接口设计，不是 Mem0 SDK 的原生参数。字段语义以[经验模型](02-experience-model.md)为准。

## 调用边界

核心通过一个本地服务暴露版本化 API，可由 CLI、MCP 或界面调用。调用上下文中的 principal、grantedScopes 和 adapterIdentity 由本地认证及配置提供，不能从模型生成的 JSON 取值。首期仅本机单用户，服务仍验证本地令牌和允许的范围；不开放未认证网络端口。

scopeId 是用户创建的知识归属和授权集合，`project:alpha`、`personal:engineering` 只是示例。适用性由 applicability 和条件独立表达，可以针对工作领域、流程、工具，也可针对 repo/branch。Copilot 可以绑定项目集合及明确授权的通用集合；采集时的分支不会自动写入适用限制。跨集合发布作为新的 proposal 重审依据和脱敏，不继承私有来源的 supported/active；derivedFrom 首版限同 scope。

## 核心操作

| 操作 | 输入 | 输出与关键行为 |
|---|---|---|
| `submitMaterial` | scope、材料片段、可选目标主题或 verificationFor={id,revision} | jobId；已接收不等于已保存/验证；补证目标须同 scope 且已授权 |
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

verificationFor 只关联经验主张的补充证据；本次任务条件确认使用 recall 的 target+更新 context，不通过该字段产生长期支持。它不授予执行权限、角色或 verified 状态。服务确认补证与目标主张/修订相关；目标已变时不自动激活新修订。普通代理填写 role=tool 也不能把转述当成真实观察，需可信宿主绑定。

这些是应用层能力，不要求全部成为代理可调用工具。首版代理 MCP 暴露 recall、inspect、submitMaterial 和 feedback；删除、范围管理与完整导出由用户界面或 CLI 控制。对同一功能只有一个服务实现。

expectedRevision 是服务提供的并发防覆盖条件：服务在同一写协调临界区内读 Mem0、比较 expectedRevision、登记屏障并启动该唯一写操作。Mem0 没有对应 CAS；此保证依赖唯一写通道，且 uncertain 操作阻断后续修改。不能由接口名推断出数据库原生条件写。

## 材料与提取 proposal

以下示例不含 eventId、sessionId、repository 或邮箱字段。数组下标只在该次提取请求中绑定来源。

输入 role 是来源声称，服务必须按通道确定实际归属。可信原生 SourceAdapter 可以绑定宿主提供的角色；普通 MCP 来自代理，其文本不能因填写 user/tool 就晋升为用户陈述或工具观察。手动入口由认证用户提交，但引用的外部文本仍保留 external 归属。excerpt 校验只证明引用一致，不能证明声称角色真实。

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

初始限制：每次脱敏材料请求的完整 JSON 最多 32 KiB UTF-8（含上下文）、16 个片段、每作业最多 8 条 proposal。经验记录、条件和 evidence 的字段与容量以[存储数据模型](07-storage-model.md)为准。超限返回 `input_too_large`，不默认截断。扩展负责按主题和完整语义分片；关联材料可后续补充，不要求任务已结束。首期长文完整知识提取不在这组限额的质量保证中，后续要单独评测分片漏学。

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

context 是当前任务上下文，不是权限。scopeIds 仍与调用身份授权求交；code.repo、branch 等由绑定宿主提供，模型不能覆盖可信值。缺失信息保持缺失，不用字段名、生成文件的猜测或历史上下文代填。新增上下文必须来自本次任务的用户说明或实际读取/观察，不能仅填写“已验证”。

请求可携带 contextEvidence（最多 4 条）：`{keys, excerpt, role, locator?}`。每条关联 1–4 个 context key、原文最多 512 B、locator 最多 256 B，role 由接入通道验证，沿用 Material 的角色规则；纯代理声称不是工具观察。keys 只指出待评估的键，不证明值成立。服务核对材料对象、版本/当前性与断言关系；不支持或相互冲突的值仍为 unknown。

事实性 context 值须由可信宿主直接绑定，或有符合条件所需证据的 contextEvidence，不能只靠裸值解除缺口。真实用户原话足以表明本次任务类型/意图，但其对工具行为的客观断言仍按相应证据要求检查。这些片段只用于请求/任务短期评估，不存 Experience、来源计数或新证据库。

默认模式 semantic，exact 用完整实体值查询，field 对 conclusion/conditions 等正向字段做词项过滤。查询模式与结果用途分开：mode 不决定 guidance/lead。exceptions 查询统一使用 browse(query, field=exceptions)，返回可见记录供调查而非自动上下文；recall 请求 exceptions 字段返回不支持，不借此增加第三种 usage。

includeLeads 默认 false。启用者必须保留 usage 与缺口含义、实现先核实后采用；官方 Copilot plugin 只有通过此协议验收后才显式开启。不能静默给只理解结论文本的客户端增加线索。

| 逐项判断结果 | 返回行为 |
|---|---|
| 资格有效、任务相关、条件全部满足且例外均排除 | taskApplicability=applicable，usage=guidance |
| 资格有效、任务高度相关、无已知不满足，但缺少明确可核实的当前信息 | taskApplicability=undetermined；includeLeads=true 才返回 usage=lead |
| 已知必要条件不满足或任一例外成立 | 不返回条目；定向重评可给 not_applicable 原因 |
| 持久 applicability=unknown，或 held/disabled/过期/来源失效/无权限 | 不通过自动资格，不能改成 lead |

返回结构包含 items、status、mode 和 reason。所有 items 带 id、revision、purpose、结论、applicability、条件、例外、basis、assessment、有效区间、usage、taskApplicability、匹配字段和来源数量。lead 另有短 relevanceReason 和 missingChecks；每个检查点引用 condition 或 exception 的当前数组索引，提供具体 question 和可选 contextKey，不返回待执行命令。

默认最多 3 项、总计约 800 token，最多 1 条 lead；先容纳 guidance，预算不足不放线索。条件、例外、依据标签、usage 或核实问题无法完整容纳就少返回，不截掉它们来凑数。evidence 正文仍按 inspect 展开；lead 只能用于判断先看什么，不能作为执行经验建议的依据。

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

Agent 先检查问题是否可在当前任务权限和剩余预算内回答。可以核实时读取相关配置/标记等，补充实际观察；不把 missingChecks 当作额外授权，不执行其文本，不要求每条经验重新跑完整测试。

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

有 target 时仍必填当前 query、scopeIds、context（可以是空对象），遵循普通资格检查。它仅避免语义 top-k 漏掉指定项，不跳过相关性和条件。先校验当前授权、active/合法依据、有效期、来源/依赖和写屏障；任一失败或目标不存在统一 items=[]、reason=target_unavailable。全部通过后才比较 revision，已变则 target_changed，消费端丢弃旧 missingChecks 再按当前版本召回，不用变更提示泄露失效/隐藏内容。

每个真实用户任务针对同一经验最多两轮核实，只有新信息才继续。重复 recall、缺口换序或目标修订变化不重置预算；缺权限、工具错误、无增量或预算耗尽后停止检查，不能降级为 guidance。轮次只记在消费端短期任务缓存；重启丢失此状态时不自动恢复该旧线索检查。

一轮指为回答缺口执行一组有界检查并提交一次重评；采用前仅刷新记录/权限、复用仍有效上下文，不算新取证轮次，也不得借刷新触发额外无预算检查。两轮限制按同一经验 ID 计，不按问题文字或返回顺序计。

采用经验开始新的动作前，官方适配应定向刷新当前记录与仍成立的上下文；repo、branch、对象、版本或用户约束变化立即废弃当次判定。核心只保证响应组装时的当前性，不宣称能收回已送入代理的文本。刷新失败则不用旧缓存继续取得指导资格。

当次重评不改 Experience、revision、assessment 或有效期。核实若另发现通用的新支持/反例/条件，才用 submitMaterial(verificationFor={id,revision}) 提交实际材料，由核心重新准入；本次不适用、单次操作成功和工具报错不能自动变成全局修改或删除。跨 scope 材料不直接补证通用集合，按发布与脱敏规则处理。

`reason` 保留 no_match、not_applicable、applicability_unknown、dependency_pending、budget_exhausted、storage_unavailable、provider_unavailable，并增加 target_changed/target_unavailable。applicability_unknown 指无法定为 guidance；可以伴随一条合格 lead，也可以没有可用线索。response 不披露无权限候选被筛掉的详情。

反馈 irrelevant 的语义是“这次任务不相关”，不应全局停用经验。helpful 只帮助分析本次使用收益，不授予已验证、不增加因果支持或自动延长有效期；重复投递和模型复核也不能升级 assessment。incorrect 带 targetRevision；若目标已变，服务返回版本冲突，避免误停新经验。真实用户明确指出被引用经验错误时，先持久化目标屏障，再生成带 review 的 held 修订并处理 correctionText。当前任务的临时例外不视作错误反馈；本人明确改变偏好按其意图修订，事实纠正则核对依据。代理自行怀疑产生待检查反馈，不伪装为用户授权；实质矛盾也按证据策略暂缓建议。首版不保存每次上下文投递的完整事件日志，使用有限诊断采样与开发评测统计。

自然语言纠正有两条明确路径：可信宿主适配捕获原始用户文本、绑定当前上下文中经验 ID/修订后直接调用 revise；没有该宿主能力时，MCP feedback 传递 correctionText 和目标修订，核心将其作为代理转述的纠正材料处理。目标不唯一时先继续提取材料，向用户展示可选择的经验，不猜测并修改多条。服务分配来源角色，模型不能自报 user 身份。插件回执分别说明已接收、已暂停目标或新修订已生效，不能收到 jobId 就说“已记住”。

持续性不明的输入默认不长期保存，必要歧义才请求澄清。用户说“记住”只提供保留意图，不能证明客观内容；低依据假设需要具体用途、显式保留与有期限的 review 才可 held。用户无需审核所有被拒绝 proposal。

## 纠正回执与展示时机

收到用户纠正后，先区分针对某条已存经验的实质纠错、本人改变长期要求，以及当前任务的临时例外。目标必须明确、版本未冲突、归属可信，才按相应路径暂停或修订。临时例外不暂停长期经验；普通 MCP 代理转述不能自报“已替用户停用”。

| 用户反馈阶段 | 服务确认条件 | 展示示例 |
|---|---|---|
| 已收到纠正 | 脱敏输入与处理作业已可靠保存，返回稳定 jobId | “已收到，正在处理这条经验。” |
| 旧建议已暂停 | 已明确目标及其修订，暂停屏障或 held/disabled 当前状态已确认，旧版不再通过投递门槛 | “旧建议已暂停，更新完成前不会继续推荐。” |
| 新规则已生效 | 目标新修订通过准入，同修订文本/向量/metadata 写入完成并读回、索引字段可读，相关写屏障解除，当前自动资格与有效时间通过 | “已更新：项目使用 pnpm，legacy/ 仍使用 npm。” |
| 尚未生效或无需保存 | 缺证据、目标不明、被判临时、未来才生效、处理失败或结果未知 | 明确说明原因和旧目标是否仍暂停，不使用“已记住” |

“已生效”表示该修订当前具备参与正常召回的资格，不表示对所有任务适用，也不保证任意查询都命中。当前任务仍执行 guidance/lead 判断和采用前刷新。仅得到 add 返回值、写操作 acknowledged、job completed 或保存为 held，都不足以报告生效。

revise/feedback 的写响应与 getJob 返回同一 receipt 投影：`accepted`、可选 `target`、`previousUse`、`replacement` 与 reason。它表达独立事实，不把三个阶段强制做成必须经过的状态机；首次新增经验无旧目标，快速直接替换也不必单独发暂停消息。

旧建议的暂停只有经服务确认后才能回报。接收后到执行暂停之间若目标修订已改变，先按 expectedRevision 处理冲突，不影响新修订。未确认的屏障写、目标歧义或版本冲突时，最多说输入已收到；新提炼失败不会自动撤销已经确认的暂停。屏障仍有效时可说“旧建议保持暂停，新内容尚未生效”。暂停不代表能回收已经进入其他代理上下文的旧文本。

快速完成时合并成一次带实际结论和范围的最终确认。未立即完成时，显示一条接收/暂停的进行中状态，最终更新为生效或未生效；不机械弹出三条消息。没有明确用户纠正的普通后台提炼只更新 UI 学习状态，不逐条打断会话。

官方适配用客户端 SDK 跟踪该 job，使用有上限、退避的 getJob 查询；不依赖模型主动想起查询任务。每次显示前以服务最新 receipt 为准，客户端丢弃较早响应；同一 job 的相同状态仅更新原显示项，不重复通知。会话仍在运行时用宿主实际支持的回执位置；宿主不能异步展示时，UI/CLI 保留可查结果并明确能力限制，不伪造聊天回复或启动新 Agent。

getJob 不能只根据历史 completed 结果宣布当前生效。服务按当前权限、目标版本、来源/依赖、状态和有效期重新检查；结果已被后续修订、停用、删除或过期时，报告 updated_again/unavailable 等当前原因，不展示被隐藏内容。网络不可用时显示无法确认当前状态，不能沿用缓存说仍生效。关闭会话/UI 不取消已接收作业；作业记录到期后仅能查询当前经验，不伪造过去通知历史。

## 扩展能力

AgentAdapter 对接代理会话，可实现 SourceAdapter、ConsumerAdapter 或两者，Copilot plugin 属于此类。Connector 对接长期外部来源，提供增量读取、转换与来源变化；ConnectorRuntime 统一处理定时、重试、接收确认和游标。[持续同步合同](08-connectors.md)定义拉取与认证推送。ExtractionModel 单独提供模型推理，与来源接入独立。

扩展清单声明 id、版本、输入能力、可用范围及可选条件评估能力。首期使用显式注册模块，无需插件市场、自动发现总线或热加载框架。持久同步状态通过网关保存到同一 Qdrant 的扩展私有命名空间；凭据使用系统凭据设施，不额外引入数据库。卸载后既有经验仍可查询，是否删除由用户明确选择。

### Copilot 适配

交付形式为 GitHub Copilot CLI plugin。它是可安装的插件目录/包，不是 VS Code VSIX，也不是替代 Copilot 的自定义代理。首期按官方 Agent Plugins 1.0 格式组织：根目录 plugin.json、mcp.json、skills/，Copilot 专属 hooks 位于 com.github.copilot/hooks/。最终 manifest 与 hook 事件清单须在固定 CLI 版本上校验，不把宿主文档支持等同于已完成采集。

插件包含以下内容：

- 插件清单：名称、版本、组件声明及安装说明。
- hooks 与短时脚本：接收实际支持的宿主信号，组织材料、传递上下文与用户纠正；不在 hook 中执行耗时提炼。
- MCP 配置及 stdio bridge：暴露 recall、inspect、submitMaterial、feedback，转发到同一个核心 HTTP 服务。
- 必要的 skills：说明 guidance/lead、验证权限和结果分流；用途保留、预算与状态刷新由适配代码和实际运行验收保证，不只依赖提示词。
- 适配配置与诊断：核心连接、授权集合映射、能力检测、超时与兼容版本检查。

使用根插件目录中的 bridge/脚本作为入口，具体编译输出路径在打包阶段固定。插件不包含另一套 Mem0/Qdrant 实例或经验生命周期。核心未运行时返回明确不可用，不把每次 MCP 启动变成创建新核心进程。卸载插件只移除宿主接入。

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

可另复用 Copilot SDK 作为提取模型提供商。它使用用户已授权的登录环境、模型额度、截止时间与取消；这是模型配置，不是核心要求。不能把“Copilot 可消费经验”与“已有内置 Mem0 Copilot provider”混为一谈。当前官方核验没有该内置 provider。

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

“新任务”是用户发起的工作目标，不是每个工具事件、模型轮次或进度确认。首条实质请求/明确新目标触发开始召回；当前任务的补充条件或纠正不自动当成新任务。任务关联与输入指纹只用于消费端短期去重，不新增永久任务事件账本。无法判断目标是否改变时，保留当前任务预算，按新信息补召回即可。

每个在途 recall 绑定调用时的任务、上下文快照和适配内存请求序号。已取消、超过截止时间、被新请求替代，或用户切换目标/目录/分支/相关对象后，迟到响应不得注入当前任务；必要时重新请求。序号不持久化；重复 hook 与相同输入合并，不能重复加入上下文。

开始召回只允许有界等待，不在 hook 中等待后台提炼或运行验证。超时/服务不可用时，宿主继续原任务并显示召回不可用状态；不得声称已经参考经验。相关动作前 target 刷新失败则不用旧缓存取得指导资格，是否以原任务自身已有依据继续由宿主决定。

安装诊断分别检查任务开始回填、采用前刷新、可信材料捕获与异步回执能力。缺少某项时报告具体限制；只有模型主动调用 MCP 的配置标为“仅工具调用”，不算首版自动使用验收通过。所有能力的失败处理均不扩大宿主权限。

### 持续同步 Connector

Connector 支持原始材料和现成 experience_draft，后者仍须核心校验归属、条件与证据，不能导入外部 active/supported、用户角色或内部 ID。受信 Connector 调用 ingestChanges，普通 MCP submitMaterial 不获得同步控制权限。

ConnectorRuntime 管理连接实例、计划、限流、背压、可靠接收与学习进度。接收确认后才推进外部游标，提炼成功单独报告。源对象变化、删除和权限撤销通过统一来源控制进入核心，原生协议与对象键保留在同步映射中。

UI/CLI 提供添加、检查、立即同步、暂停/恢复、状态、重新认证与移除。邮件、文档目录、知识库或复盘系统只是实例，具体实现按需交付。暂停停止新采集，已接收学习默认继续；移除默认保留经验。完整合同以[Connector 持续同步](08-connectors.md)为准。
