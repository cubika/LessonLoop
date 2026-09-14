# 开发评测材料

日期：2026-09-14。已从 ProvenLoop 的 92 个手写学习窗口中选择 48 个，保存为不依赖旧运行时的本地材料。它们还需要 LessonLoop 的输入适配、独立标签和具体任务判定器，当前状态是 `needs_oracle_review`。

## 为什么精简

首批保留能暴露不同错误的材料。通用语义集覆盖有持续用途的纠正和相近反例；Agent 集保留自主调查与恢复；参数集保留少量中英对照。原始选择、暂缓原因和文件 hash 见[来源清单](provenloop/manifest.json)，实际材料见[开发集](provenloop/materials.json)。没有迁移旧 runner、模型输出、通过记录或人工标签。

| 来源 | 原有窗口 | 本次保留 | 取舍 |
|---|---:|---:|---|
| general | 40 | 24 | 保留 12 个主题的正反例；8 个领域扩展主题暂缓 |
| agent | 12 | 12 | 来源、时序、恢复、混杂变量、重复召回和普通成功各有不同作用 |
| automatic | 40 | 12 | 保留 6 类中英材料；参数换名暂缓，生命周期文字样例改建真实状态测试 |

48 个窗口是开发输入数量。翻译、正反例和相似案例仍有关联，不能视为 48 个独立收益任务。所有材料均已在旧项目中用于开发或审阅，统一归入开发回归集，不用作冻结保留集。

## 保留哪些内容

general 保留 `INT-07`、`INT-03`、`DAT-01`、`DAT-02`、`DAT-07`、`API-01`、`API-02`、`API-03`、`DEV-03`、`DEV-07`、`ART-01`、`ART-06`，每个主题保留纠正和近似反例。它们分别涉及指标定义、当场改口、空值含义、舍入、总体统计、提交确认、过时响应、幂等、生成文件、验证目标、文档语言和模板值。

general 的 `DAT-03/04/06/08`、`API-05/08`、`ART-04/08` 留在扩展清单。它们仍有价值，但首批可先用上述主题检查条件、例外和作用域是否丢失，再扩到单位、日历、分页、事务、资源释放和表格等领域。

agent 的 12 个窗口全部保留。`EXP-01-repository-guide` 与 `DEV-03` 都涉及生成文件，前者是工具读取的指南，后者是用户要求，可以检查相近内容的来源身份是否被混淆。两者归入同一关联组。

automatic 保留 `required_path`、`multistep_correction`、`paraphrased_constraint`、`temporary_request`、`question`、`quotation` 的中英版本。其他必填参数多数只是换字段名；暂缓项仍记录在清单中。

## 材料与判定分开

`materials.json` 中每个 case 的 `input` 保存按原顺序整理的来源事件、材料正文、工具参数和已声明的工具合同。事件与合同均为手写 fixture，身份只在隔离评测通道内成立，不是实际宿主运行证据。原始正文、时间和来源角色保留；旧捕获系统的重复 hash、调度与会话外壳不进入输入。来源文件和逐条来源定位用于核对迁移。

`originalStratum` 仅保存旧作者的分类。`negative` 不自动对应零经验，`correction` 也不决定应为 active 或 held。每条的 `reviewNotes` 和验收 ID 是待复核的开发提示，不能作为 gold label，不能传给提炼模型。

后续适配器只向模型提供必要正文、可信来源角色和工具数据，来源引用使用不含判定含义的编号。原始 caseId/sourceEventId 可能含 negative、premature 等设计词，只用于追溯；不能把整条 fixture 直接作为模型请求。

重点复核这些差异：

- 用户有权制定的持续要求可成为 attributed constraint；对环境的事实陈述仍需依据，不能沿用 ProvenLoop 的统一 candidate 预期。
- 参数集即使把用户话语标为 negative，也包含失败、成功重试和工具 schema。提问或临时请求不能变成用户长期偏好，但 schema 支持的窄事实可能值得保存。
- `EXP-05-confounded-changes` 同时改变多个参数，禁止据此确认唯一原因；独立 schema 支持的必填参数事实另行判断。
- `EXP-05-ambiguous-retries` 的真实 fixture 关系仍可能定位成功操作，不能仅凭 Agent 自述“无法确认”强制拒绝。
- `EXP-06-premature-summary` 既有过早总结，也有之后到达的成功结果。必须明确评测截止点，分别检查当时能知道什么与任务结束后能学到什么。
- `EXP-08-recalled-guidance` 要补已有经验和来源身份，才能证明没有重复增加支持；一句“此前召回”不能代替初始库状态。

原项目的后续任务多为模板描述，本次没有把它们复制成可运行任务。需要按[场景合同](../docs/09-quality-evaluation.md#从验收要求到场景合同)补项目文件、当前条件、适用/不适用任务、独立 oracle、操作与清理入口。

## 日常选择与校验

[选择配置](provenloop/selections.json)包含两个材料子集：`smoke-16` 用于后续开发时快速检查主要差异，`development-48` 用于较完整的开发回归。它们只选择材料，还不是带阈值的可执行评测 profile。

```powershell
node scripts/validate-eval-corpus.mjs
```

该命令只检查材料数量、身份、来源与内容 hash、关联组、选择配置和验收 ID。校验通过不表示提炼正确，也不会启动模型或写入经验库。

一次性同步使用同级 ProvenLoop 中已保存的手写 corpus 文件。以后要重新同步，应在更新来源与选择决策后执行：

```powershell
node scripts/sync-provenloop-corpus.mjs --source ../ProvenLoop
node scripts/validate-eval-corpus.mjs
```

同步先检查三个来源都是 `authored_replay`，拒绝未知 case；未使用 `--overwrite` 时不覆盖已有材料。来源 JSON 的路径、原始字节 hash 与生成代码 hash 均进入清单。校验已同步文件无需访问 ProvenLoop；重新同步需要清单中列出的本地来源文件。

## 仍需新建的场景

| 缺口 | 原因与下一步 |
|---|---|
| 生命周期与授权 | `expired_candidate`、`instruction_duplicate`、`synonymous_repeat`、`conflicting_constraint` 只用文本描述状态；改建实际经验、时间、修订、来源和授权数据，再执行更新/召回 |
| 来源身份与脱敏 | 原参数集的引用文本由 user 角色提交；结合保留的 Agent 工具来源样本，另建真实不可信输入与脱敏断言 |
| guidance/lead 核实 | 旧 Context 行为不同；需要目标修订、当前条件、核实证据和采用前刷新 |
| 写入与来源撤回 | 需要真实后端的中断、未知提交、重启、派生失效及删除副本检查；“API 提交后才成功”的材料只测能否学会这种要求 |
| 多层学习与真实收益 | 需要独立来源、反例、较晚任务、真实产物与保留集，不能靠复制短窗口增加样本数 |
| 安装、宿主与 Connector | 需要真实入口、进程、同步游标和回执；沿用[八组场景](../docs/09-quality-evaluation.md#首批场景与样本管理)逐项补齐 |
