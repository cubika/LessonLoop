# 文档地图

当前设计以官方Hindsight工具和可复用Agent模块为起点，围绕“经历 → 分层提炼 → 方法 → 使用 → 改进”组织。以下是同一版产品合同，均尚未实现。

## 阅读顺序

先读产品与学习模型，再看方法库体验；实现时阅读架构、数据和接口。阶段与测量分别维护，避免把实现细节散在产品说明中。

| 文档 | 唯一职责 |
|---|---|
| [01 产品定义](01-product.md) | 用户价值、首版范围、设置和官方分工 |
| [02 自动复盘与方法学习](02-experience-model.md) | WorkCase/Experience/Method语义、L1–L5实际处理、准入与演进 |
| [12 方法库与使用体验](12-method-library.md) | UI、CLI、任务使用、变化与导出 |
| [03 系统架构](03-architecture.md) | 组件、官方复用、可替换引擎、发布投影与恢复 |
| [07 数据模型与保留](07-storage-model.md) | 字段、引用、状态记录、所有容量和保留期 |
| [04 接口与Agent接入](04-contracts-and-extensions.md) | 产品操作、准备推进、回执、能力和事件协议 |
| [08 外部资料接入](08-connectors.md) | 快照/事件/纠正、可靠接收、游标和来源控制 |
| [11 工作结果与效果回顾](11-post-release-evaluation.md) | 学习/回顾路由、方法变化、统计、通知和开发导出 |
| [10 本地发行与运行](10-distribution-and-installation.md) | 官方组件打包、Windows安装、后台、升级和清理 |
| [05 实施与验收](05-delivery-and-validation.md) | P0–P4阶段、产品与组成规则验收、发布门槛 |
| [09 质量评估方法](09-quality-evaluation.md) | 场景合同、分层判定、官方对照、指标和报告 |
| [06 架构决策](06-review-and-decisions.md) | 选择理由、P0未决项和调整条件 |

## 当前文档与实现

README及本目录描述目标产品。仓库代码目前只有Experience子集检查、两个任务判定器、材料和Copilot协议探针。WorkCase、Method、真实分层提炼、Hindsight适配和产品UI均不能从字段或探针存在推断为已实现。

[evals](../evals/README.md)说明实际开发材料及限制，[probes](../probes/copilot/README.md)说明可运行宿主检查。当前文档不保留Mem0专用实现作为待办。

## 研究与维护

[研究索引](research/README.md)保留当前使用的官方能力依据和Copilot协议证据。已退出的原型资料从Git历史追溯，不保留为当前设计的另一套要求；旧运行结果不继承为新架构通过证据。

修改语义先改所属主文档，再同步调用、数据和验收引用。预算只在07定义，验收门槛只在05定义。文档校验检查结构和本地链接，跨页语义需要人工或独立审查，运行能力还需实际测试。
