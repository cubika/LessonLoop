# 统一领域模型

日期：2026-09-15。当前实现只定义 Source、Experience、Playbook 三类领域对象；API、核心类型和持久化使用相同名称。

| 对象 | 保存什么 | 如何关联 |
|---|---|---|
| Source | 一个获准保存的原文片段，附来源身份、时间、工作归属和控制状态 | id 就是片段指纹；一次提交多个片段，得到多个 Source |
| Experience | 一条可独立复用、核实和纠正的主张 | evidence 指向 Source；derivedFrom 可引用其他 Experience 修订 |
| Playbook | 目标、条件、步骤、分支、检查和停止要求 | supportRefs 指向 Experience 修订；predecessors 记录方法沿革 |

关系是：Source 支撑 Experience，Experience 支撑 Playbook。实际任务使用 Playbook 后，新的观察继续作为 Source 输入。来源可以直接提炼经验，不要求先生成完整案例。

WorkView 是 core 内的工作聚合缓存，按 workKey 更新，包含尝试、结果和未解决问题。它不进入 ObjectRef，也不成为 Playbook 的依赖。使用视图直接读取 task_feedback 的当前投递、结果和评价，同样没有独立领域身份。

任务、学习作业、接收回执、发布水位与清理记录属于运行数据。它们保证重试、乱序输入、来源撤回和结果关联可靠，不构成额外知识层。批量提交仅是一种输入格式，不再保存 Material 实体。

已删除 Method 领域名称、双向公共字段转换、旧学习 Schema 和共享引擎运行分支。产品存储版本为 3：Playbook 当前正文由 Hindsight 保存，产品库保留状态、来源和内容哈希，不维护历史正文。格式 1、2 明确报不兼容；格式 3 内已有反馈与作业字段的启动整理见[07](07-storage-model.md)。

实现入口：[领域定义](../src/domain/schema.ts)、[经验定义](../src/domain/experience.ts)、[内部工作视图](../src/core/work-view.ts)、[直接接口分发](../src/core/server.ts)。字段和保留要求见[存储模型](07-storage-model.md)。
