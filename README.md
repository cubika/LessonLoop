# LessonLoop

LessonLoop 帮助个人和工作Agent从真实工作中持续学习做事方法。它整理经历、执行L1–L5提炼、形成排查流程和决策清单，在下一次任务中使用，并根据新结果改进方法。

**当前处于设计与技术验证阶段，没有可安装产品。** 仓库仅有设计文档、Copilot协议探针和评测辅助工具；真实方法学习、Hindsight适配、核心服务、UI和Windows发行均待实现。

实现以官方Hindsight自托管和可复用Agent模块为起点。原生提取、归纳、综合和索引尽量直接复用，LessonLoop持有工作案例、产品经验、方法版本和用户控制。MemoryEngine保持可替换，首期只实现Hindsight；模型使用现有Copilot订阅，本地存储不代表推理离线。

## 从哪里开始

| 主题 | 文档 |
|---|---|
| 产品做什么 | [产品定义](docs/01-product.md) |
| 怎样从工作学出方法 | [自动复盘与分层提炼](docs/02-experience-model.md) |
| UI、CLI和方法使用 | [方法库](docs/12-method-library.md) |
| 官方工具怎样接入 | [系统架构](docs/03-architecture.md) |
| 实现阶段与完成标准 | [实施与验收](docs/05-delivery-and-validation.md) |

完整导航见[文档地图](docs/README.md)。工作学习、自动推荐、效果回顾和提醒分别配置；真实新结果可以学习，统计和周报不作为新的独立证据。

## 仓库内容

| 路径 | 内容 |
|---|---|
| docs/ | 当前方法产品设计 |
| docs/research/ | 固定来源与历史运行记录 |
| probes/copilot/ | 固定CLI版本与合成模型的协议探针 |
| evals/ | Experience子集检查、两个任务和48个待适配材料 |
| tests/、scripts/ | 辅助代码测试及文档/材料校验 |
| .local-validation/ | 不提交的隔离环境和校验报告 |

历史Mem0/Qdrant原型已停止维护，报告仅供追溯。现有level枚举和确定性判断不等于已实现L1–L5提炼，材料数量也不代表通过的任务数。

## 在源码中运行检查

需要Node.js 22.18+。这些命令检查现有辅助代码和材料，不启动产品或真实模型。

```powershell
npm ci --ignore-scripts
npm run validate:docs
npm run validate:evals
npm run typecheck
npm test
```

报告写入.local-validation/results。真实CLI探针的准备和范围见[说明](probes/copilot/README.md)。计划中的统一Windows安装入口尚无下载地址，设计见[本地发行](docs/10-distribution-and-installation.md)。
