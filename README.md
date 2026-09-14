# LessonLoop

LessonLoop 从日常调查、用户纠正和外部资料中提炼经验，保留来源、适用条件与例外，在后续任务中帮助代理少做重复调查。

**当前处于设计与技术验证阶段，还没有可安装的产品。** 仓库包含设计文档、Copilot 协议探针和通用评测工具。目标引擎选择 Hindsight 自托管，模型使用现有 Copilot 订阅；引擎适配、正式服务、UI 和 Windows 安装包均待实现。Mem0/Qdrant 原型已移除，研究与实测记录保留供查证。

例如，代理发现直接修改生成客户端会被覆盖，就应记住修改生成源的做法。下次遇到类似任务，先判断目标是否为生成文件；手写文件不套用这条经验。来源更新或用户纠正后，旧建议要及时停止使用。

## 从哪里开始

| 想了解什么 | 阅读入口 |
|---|---|
| 产品有什么用、计划怎样使用 | [产品定义](docs/01-product.md) |
| 经验怎样形成、什么时候能用 | [经验模型与学习规则](docs/02-experience-model.md) |
| 核心、记忆引擎和代理怎样配合 | [系统架构](docs/03-architecture.md) |
| 下一步实现什么、如何判断完成 | [实施与验收](docs/05-delivery-and-validation.md) |

其余接口、数据结构、同步和发布文档按需查阅，完整导航见[文档地图](docs/README.md)。已有结果与选型依据见[研究及验证记录](docs/research/README.md)，历史报告只说明所记录版本的实测范围。

## 目录说明

| 路径 | 内容 |
|---|---|
| docs/ | 当前产品设计、合同、实施与验收要求 |
| docs/research/ | 有日期的选型依据、原型设计与运行证据 |
| probes/copilot/ | 与记忆引擎无关的 CLI 及 hook 协议验证 |
| evals/ | 通用适用性检查、任务 runner、两例任务及 48 个待适配学习窗口 |
| tests/ | 协议探针与通用评测工具的单元测试 |
| scripts/ | 校验、Copilot 探针准备及材料同步工具 |
| .local-validation/ | 当前工具的隔离运行时、临时数据和报告，不提交 Git |
| .p0/ | 已停止维护的原型本地输出，仅保留历史日志或清理记录 |

`evals/fixtures/tasks.ts` 的两个可执行任务与 48 个学习窗口用途不同：前者检查简化任务执行，后者等待标签、输入适配和具体判定器。

## 在源码中运行检查

需要 Node.js 22.18+；宿主探针的运行环境为 Windows x64 与 PowerShell。以下命令安装开发依赖并检查文档、材料及局部代码，不启动模型或产品服务。

```powershell
npm ci --ignore-scripts
npm run validate:docs
npm run validate:evals
npm run typecheck
npm test
```

文档报告写入 `.local-validation/results/document-validation.json`。Copilot 协议探针的准备及运行步骤见[探针说明](probes/copilot/README.md)。正式产品拟采用 Windows `irm` 安装入口，当前没有下载地址，设计见[发布与本地运行](docs/10-distribution-and-installation.md)。
