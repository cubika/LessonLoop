# 开发材料与评测工具

本目录保存方法产品的开发输入及局部判定工具。本目录已有开发三组执行器（无记忆、官方Hindsight SDK、LessonLoop），复用官方Copilot provider与真实文件任务判定。正式Agent hooks基线及完整质量规模仍未验收；产品学习、方法准备及发布投影在src实现。材料和字段校验通过不表示产品质量已完成，进度见[实现计划](../docs/13-implementation-plan.md)。

## 现有代码

| 文件 | 实际作用 |
|---|---|
| lib/experience.ts | Experience子集的字段与确定性适用性检查，不推断主张真实性 |
| fixtures/experience.ts | 配套手写状态和适用性样本 |
| lib/task-runner.ts、fixtures/tasks.ts | 两个生成文件/手写反例任务，依据实际文件和检查结果判断 |
| lib/model-client.ts | 通用模型调用辅助，尚未连接完整方法学习流程 |

这些代码是开发参考，不是正式核心。产品合同以[当前设计](../docs/README.md)为准，测试数量不等于验收覆盖率。

## 材料来源与划分

从ProvenLoop的92个手写学习窗口中选择48个：general 24、agent 12、automatic 12。内容保存为独立本地材料，状态为needs_oracle_review；没有迁移gold标签、模型输出或通过记录。

[manifest](provenloop/manifest.json)记录来源、选择理由、原始位置和hash，[materials](provenloop/materials.json)保存输入，[selections](provenloop/selections.json)定义smoke-16和development-48子集。它们是材料选择，不是可执行质量profile。

所有材料属于开发回归；同主题正反例、中英版本和转载关系不能视为独立收益样本。sourceEventId、caseId和reviewNotes可能带判定线索，适配时只向学习器传获准正文与真实角色，不泄漏参考答案或审阅说明。

## 怎样用于方法产品

先补WorkCase初态、真实后续任务和独立判定：哪些尝试值得保留，能形成什么分支方法，新结果应改变哪里。已有生成文件任务可作MTH场景起点；单条材料可支持局部规则，跨场景适用仍需相应材料验证。

重点区分临时要求/持续偏好、事实/猜测、工具结果/Agent自述、同源重复/独立案例。多因素改变后成功不能直接给因果正标签，失败或提问材料也可能包含有价值的工具事实。

生命周期、来源撤回、投影同步、方法推进、回顾和发行需要真实状态与执行场景，不能只用文本描述通过。场景和数据划分按[评估方法](../docs/09-quality-evaluation.md)，验收ID由[05](../docs/05-delivery-and-validation.md)与[08](../docs/08-connectors.md)维护。

## 检查与同步

开发对照使用`npm run validate:product-profile`检查配置，再用`npm run evaluate:product -- --core-config <本机配置路径>`运行。profile在`evals/profiles/development.json`；私有Python调用官方Copilot provider，三组隔离工作目录与存储范围。SDK官方组保留提取、归纳、知识模型和reflect，未冒充完整官方Agent插件基线。完整上下文超预算会报错，所有失败和未知成本保留在报告，发布门槛单独报告为未评估。

```powershell
npm run validate:evals
```

命令校验数量、身份、来源、hash、关联和选择配置，不启动模型或任务。无需访问原ProvenLoop即可检查已同步文件。

需要重新同步时，先更新来源与选择决策，再执行：

```powershell
node scripts/sync-provenloop-corpus.mjs --source ../ProvenLoop
npm run validate:evals
```

同步只接收已声明authored_replay来源，拒绝未知case；默认不覆盖已有材料。重新同步需要清单中的本地源文件，不能凭当前评审结论改写归档输入。
