# LessonLoop

LessonLoop 帮助个人和工作Agent从真实工作中持续学习做事方法。它整理经历、执行L1–L5提炼、形成排查流程和决策清单，在下一次任务中使用，并根据新结果改进方法。

**当前正在实现 P0–P3，尚无通过发行验收的安装包。** 核心学习、方法检索与准备、编辑/历史/导出、来源控制、样例 Connector、效果回顾及兼容升级/回滚已有实现。已补有界宿主会话采集与续用、方法库完整管理、案例补结果、定向经验召回、Connector分片和逐路径演进审查；本地重排与开发三组评估入口可运行。完整质量与发行验收仍未通过。最新待办见[实现计划](docs/13-implementation-plan.md)，实际证据见[运行记录](docs/research/2026-09-14-implementation/README.md)。

产品仍在开发，没有需要迁移的旧用户数据，首版从当前数据格式初始化。Copilot 接入优先复用官方采集、回填和诊断模块；方法库负责查看、管理和关联任务，实际多轮工作由 Copilot 执行。

实现以官方Hindsight自托管和可复用Agent模块为起点。原生提取、归纳、综合和索引尽量直接复用，LessonLoop持有工作案例、产品经验、方法版本和用户控制。MemoryEngine保持可替换，首期只实现Hindsight；模型使用现有Copilot订阅，本地存储不代表推理离线。

## 从哪里开始

| 主题 | 文档 |
|---|---|
| 产品做什么 | [产品定义](docs/01-product.md) |
| 怎样从工作学出方法 | [自动复盘与分层提炼](docs/02-experience-model.md) |
| UI、CLI和方法使用 | [方法库](docs/12-method-library.md) |
| 官方工具怎样接入 | [系统架构](docs/03-architecture.md) |
| 第一阶段怎样实现P0–P3 | [实现计划](docs/13-implementation-plan.md) |
| 实现阶段与完成标准 | [实施与验收](docs/05-delivery-and-validation.md) |

完整导航见[文档地图](docs/README.md)。工作学习、自动推荐、效果回顾和提醒分别配置；真实新结果可以学习，统计和周报不作为新的独立证据。

## 仓库内容

| 路径 | 内容 |
|---|---|
| docs/ | 当前方法产品设计 |
| docs/research/ | 固定来源与历史运行记录 |
| src/ | 产品领域、存储、Hindsight 适配、核心 API、CLI 和最小页面 |
| distribution/、config/ | 固定组件、Windows 数据库构建与引擎兼容层；尚非完整安装器 |
| probes/copilot/ | 固定CLI版本与合成模型的协议探针 |
| evals/ | Experience子集检查、两个任务和48个待适配材料 |
| tests/、scripts/ | 辅助代码测试及文档/材料校验 |
| .local-validation/ | 不提交的隔离环境和校验报告 |

历史Mem0/Qdrant原型已停止维护，报告仅供追溯。现有level枚举和确定性判断不等于已实现L1–L5提炼，材料数量也不代表通过的任务数。

## 在源码中运行检查

需要Node.js 22.18+。下面的检查和构建不调用模型。

```powershell
npm ci --ignore-scripts
npm run validate:docs
npm run validate:evals
npm run typecheck
npm test
npm run build
```

开发 CLI 使用 `node dist/cli/main.js help`。真实数据库测试通过 `npm run test:postgres` 执行，要求已按隔离配置启动私有 PostgreSQL。`npm run validate:p0` 会调用现有 Copilot 订阅，经官方 Hindsight 运行实际方法路径；测试需要已配置的隔离引擎，不是安装命令。

报告写入.local-validation/results。真实CLI探针的准备和范围见[说明](probes/copilot/README.md)。计划中的统一Windows安装入口尚无下载地址，设计见[本地发行](docs/10-distribution-and-installation.md)。

方法演进开发验证：npm run validate:evolution 与 npm run validate:evolution-resume 仅使用已确认的合成案例，保留失败记录，不代表完整阶段验收。

`npm run validate:host` 验证真实Copilot回填、采集和MCP续用；`npm run validate:verification` 验证补证修订、发布回执和召回，均使用隔离配置与现有Copilot登录。Windows沙箱无法访问系统CLI或登录时需在同用户正常环境运行，失败单独保留。

`npm run validate:product-profile` 只检查开发对照配置；`npm run evaluate:product -- --core-config .local-validation/data/core-config.json` 运行两个合成任务的三组SDK开发对照，需先停止占用同数据库的核心。官方Agent hooks基线及正式质量规模尚未由该执行器覆盖。独立本地重排的固定文件和离线验证见[组件记录](docs/research/2026-09-15-reranker/README.md)。
