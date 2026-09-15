# P0 实现与运行记录

本轮从 W01、W02、W03/W04 最小路径开始。当前仍在开发，P0–P3 均未宣布通过；安装包尚不可交付。

## 已实现并检查

- 新增产品领域 Schema、来源指纹、方法结构、支持资格与分支准备。
- PostgreSQL 独立 lessonloop schema、迁移、单写协调、CAS、可靠接收和跨重启幂等。
- 官方 Hindsight SDK 薄适配，关联原生 retain/Mental Model 操作，产品候选校验与发布屏障。
- 最小认证 loopback API、开发 CLI 和方法库页面。

TypeScript 检查、构建及 28 个现有/新增单元测试通过。真实 PostgreSQL 集成测试覆盖迁移、单实例、幂等、冲突、来源角色、任务观察与重启。它们只证明对应工程行为。

后续新增 Copilot 事件适配与产品 MCP 初版。真实 Copilot CLI 1.0.84-5 在独立验证目录中成功执行 userPromptTransformed、postToolUse、sessionEnd；宿主事件记录确认产品 lead 经 modifiedTransformedPrompt 回填，并关联核心 task/methodUse。当前仍未验证完整材料捕获、显式续用及安装注册。领域与协议单元测试增至 30 项。

新增可信观察重评入口：宿主保存实际工具结果，代理只能要求核心重评已有观察。判断绑定方法修订、执行实例和原始观察摘要；新观察使旧判断失效。使用真实 provider 的 lead→观察重评→guidance 验证通过，完整任务边界与多轮分支仍待验收。重复 prepare 使用 requestId 并重新检查当前资格，不缓存可执行正文。

原生模型创建的 HTTP 接口先建模型再排刷新，回执丢失可能留下半提交。新增薄扩展在独立元数据 schema 先登记完整内容摘要，按稳定模型身份恢复官方操作；取消先保存拒收标记。真实 PostgreSQL 配合无模型原生替身验证中断、重复、配置冲突和迟到提交拒收。一次真实运行完成原生生成及独立审查，但方法因越出案例支持范围被拒绝；该质量失败保留在报告中。

手动方法修订已接上持久审查：先暂停旧版，再用官方 Mental Model 检查当前依据，核对目标和控制修订后发布。真实验证将最后一步细化为字段列表 deepEqual 检查，审查 completed，新方法恢复 active；后续用户控制或原生失败不能沿用旧审查结果。完整纠正/演进验收仍未通过。

效果回顾已有独立事件存储、任务身份检查、事件去重、unknown 结果计数和清空边界。PostgreSQL 测试验证旧事件不能恢复已清空统计，页面可查看已接收事件覆盖的任务。完整采用证据、周期回顾、通知和保留清理仍未交付。

真实宿主验证发现两项配置差异：Agent Plugins 1.0 的 manifest 必须包含准确的 `$schema`；复制完整用户 config.json 会带入已安装插件，验证环境改为仅保留账号选择字段并限定可信目录。失败运行未算回填成功。

## 官方组件实测

固定清单见 [components.json](../../../config/components.json)。官方 Hindsight 0.9.2、Copilot SDK 1.0.13、pg0 0.15.1、PostgreSQL 18.1、pgvector 0.8.5 和本地多语言 E5 已在本机 Windows 启动。E5 五个文件完整下载并通过 SHA256 校验。未使用 Docker。

官方 Copilot provider 的连接和结构化算术 smoke 通过，使用现有登录；该 smoke 不等于方法学习验收。后续方法质量配置选择当前账号可用的 gpt-5.5。Copilot 未暴露固定底层快照。

独立 PublishedProjection bank 的 chunks 模式实测无需 LLM 提取，原文与 metadata 保留。13 条材料中，12 条停用干扰项被标签前置过滤；撤回后为空，旧 active 标签在当前引用允许集合下仍被排除；中文查询找到英文正文。继续复用官方索引，不新增另一套向量库。

## 发现并修复的具体兼容问题

1. Windows 重定向输出默认 cp1252，官方启动 banner 导致 UnicodeEncodeError。子进程设置 UTF-8 和非缓冲输出。
2. 官方警告建议的 reranker=none 不受 0.9.2 factory 支持。P0 使用官方 rrf 基线；正式独立本地重排仍待交付。
3. 原生迁移在 hindsight schema 创建 pg_trgm，但实体查询使用的 search_path 看不到其操作符。私有数据库把 pg_trgm 安装到 public，原作业按原身份重试后完成。发行初始化需先创建相同扩展。
4. 官方结构化转换丢失 anyOf/enum 等语义，并传 skip_validation=True。真实结果缺少必填 applicability 仍被原生保存，产品 Zod 拒绝。新增 [兼容层](../../../distribution/hindsight_compat.py)只修复该转换入口，向官方 provider 传原始 Schema，并完整验证返回；嵌套必填、枚举、nullable 回归通过。
5. 模型重写证据 role 会失真。候选改为 sourceIndex+连续摘录，由产品绑定原始角色、来源和指纹。
6. 官方 PostgreSQL Windows 二进制不能直接处理部分中文路径。DataRoot 保持用户路径，对 PostgreSQL 调用使用系统返回的短路径；中文空格目录实际 init/start/stop 通过，未开启短路径的卷仍需另测。

完整私有 Python、Node、PostgreSQL 和 E5 已复制到独立开发 bundle。新的中文空格 DataRoot 使用 DPAPI 保存凭据并初始化产品/引擎独立 schema；核心与引擎最终健康，停止验证通过。第一次冷启动超过 120 秒，管理器报告失败但进程后来就绪，需继续完善可恢复启动。安装器尚未完成正式发行验收。

官方源码依据：[结构化提取](https://github.com/vectorize-io/hindsight/blob/v0.9.2/hindsight-api-slim/hindsight_api/engine/reflect/agent.py)、[原文 chunks](https://github.com/vectorize-io/hindsight/blob/v0.9.2/hindsight-api-slim/hindsight_api/engine/retain/fact_extraction.py)、[前置检索过滤](https://github.com/vectorize-io/hindsight/blob/v0.9.2/hindsight-api-slim/hindsight_api/engine/sql/postgresql.py)。

## 仍需完成

真实执行的生成文件案例已生成 1 个方法及 3 条相关经验；当前上下文未知时返回 lead，绑定实际 fixture 观察后返回 1 个诊断步骤，中文查询找到该英文方法。真实宿主的 lead 回填已有事件证据。报告仍标 partial_evidence：完整任务迁移、宿主材料捕获/续用及 P0 全部退出条件尚未通过。

P1 完整入口、P2 演进与生命周期、P3 Connector/回顾/完整发行和正式质量报告尚未通过。无预装环境安装、升级回滚、永久清理以及 05/09 的冻结质量/收益门槛不能以当前工程测试替代。

本地完整报告保存在 .local-validation/results，包含失败运行；发布证据不得只保留成功部分。

## 2026-09-15 发布准备进展

本轮新增来源副本清理和服务端投影写入/擦除共锁。取消按整个已登记 bank 核对原生在途操作，避免父作业取消后子作业继续写入。历史方法、已删除对象的来源绑定、任务观察及回顾贡献参与清理；旧共享布局缺少迁移时保持 pending 并给出原因。

样例 Connector 已接入 API 和页面，支持快照替换、定向纠正、撤回/擦除、父忘记、失败重试。材料接收和游标原子提交，来源族与修订身份分开。可信宿主同任务材料可形成有界综合；单调任务代次阻止旧结果覆盖新案例，普通代理自报 taskRef 不取得宿主身份。

页面新增方法编辑审查、历史比较、显式任务准备、三种导出格式、来源和 Connector 管理。浏览器中实际验证了编辑提交后的 held 修订与历史差异。周期回顾和应用内提醒已有实现及数据库回归；严重确认问题通知、开发样本导出等 O 系列功能仍待完成。

Windows 管理器可恢复单独退出的核心进程，并保留正在运行的引擎；中文路径隔离安装实测通过。重复停止通过。另做私有数据库退出后恢复：管理器重建失联核心与引擎，实际健康检查均 ready。完整升级/回滚、自启、卸载和最终发行清单仍未完成。

本轮工程验证：32 项单元测试、11 项 PostgreSQL 集成测试、类型检查与构建通过。Python 提交恢复与生命周期故障注入通过。官方原生引擎配合本地 E5 实际保留并擦除了 source bank 和发布投影，11 个被核对原生表的残留计数为零；该运行未调用语言模型。

真实 Copilot provider 重新完成 P0 路径，生成 1 个方法、2 条经验；报告仍为 partial_evidence。当前方法的观察重评返回 guidance；手工修订独立审查 passed；真实 Copilot CLI 回填验证为 injection_observed。曾因沙箱拒绝启动 Copilot 子进程出现失败和重试，保留原生操作身份后恢复，不把该故障算质量通过。

报告：.local-validation/results/native-lifecycle-validation.json、runtime-recovery-validation.json、runtime-database-recovery-validation.json、p0-method-path.json、observation-validation.json、revision-validation.json、host-product-validation.json。以上是对应功能的局部证据，P0–P3 全部退出条件及最终安装字节尚未验收。

## 2026-09-15 方法演进与复核增量

新增多方法拆分提案、精确旧支持引用、冻结原生请求 Schema、行为与支持增量分别审查，以及不依赖标题/步骤编号的无增量检查。拆分先原子保存全部子方法与前身退休，再等待整组投影确认；中途用户控制或支持失效会明确中止整组，允许后续显式重评。自动跨案例综合只选择同范围同主题的完整材料，保留独立来源族、输入案例版本和省略计数，不把多个案例汇成一次工作。

真实演进首次运行失败于结构化转换。原生反射草稿混入产品字段、遗漏必填数组并超出检查数上限。最小修复为向生成提供原草稿 Schema，并在转换失败时最多进行一次格式修复；原始 Schema 校验仍在返回前完整执行，已返回的两次用量累加。

复测生成了方法新修订并保留原支持。自审实际执行路径发现版本 2 分支顺序落入版本 1，以及全局扩展条件排除了原字段任务。该结果不算自动演进通过。已用反馈暂停，人工修正后交独立原生审查；第一次修订仍被否决，第二次通过，字段修改、版本 2 扩展、版本 1 不支持扩展三条准备路径实测通过。现已把路径展开提供给自动与人工审查；自动端到端演进还须另跑未受人工修正污染的案例。

效果回顾新增用户确认问题、严重提醒、跨任务关联、确认依据到期/擦除降级，以及选定开发样本的脱敏预览。复用现有数据库和页面轮询，没有新增通知服务。下载时重新核对内容修订，修改脱敏条件会作废预览。浏览器实测两个任务关联同一严重问题后仍保持确认状态且只显示一条提醒；脱敏预览与条件变化失效通过。

当前验证包括类型检查、构建、36 项单元测试及 18 项 PostgreSQL 集成测试；另新增旧 methods-2 审查 Schema 兼容测试。Python 兼容测试覆盖两次失败/修复后的用量、超时不重试、取消传播。完整 P0–P3 发布门槛保持未通过；上述工程与单案例证据不替代全部学习质量、宿主、生命周期和最终安装验收。

直接经验 recall 已复用官方多语言发布索引，并补精确实体优先、资格前置及返回前修订核对。19 项数据库集成测试通过；真实中文查询在合成 fixture 的英文经验中返回相关 lead，未虚构当前适用性。报告为 .local-validation/results/experience-recall-validation.json。

后续补充：Connector 使用核心既有定时器执行用户配置的同步间隔，默认关闭；关闭或改期会使旧调度代次失效。方法被独立审查拒绝时最多修正一次，所有原生操作身份及首次否决保留；总用量未聚合时明确标记，不报告为零。最新 21 项 PostgreSQL 集成通过。干净 P0 再测仍出现不受支持工具替代而被拒绝，已保存该失败，新的有界修正路径继续真实验证。


干净基线的后续实测：P0 在一次有界方法修正后生成 1 个方法。自动新增版本 2 扩展分支时，执行分支已有明确停止，但自审仍发现扩展专用全局条件使原字段任务不可用；已保存 clean-evolution-self-review.json 并反馈暂停。此项仍是自动方法质量失败，不能标 MTH06/09 已通过。
