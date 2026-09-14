# Hindsight 官方 Agent 集成与复用边界

日期：2026-09-14。范围：官方文档与源码只读核查。复核提交为 [e3efe5dd8b070d00129c5186d111c0bc5f992363](https://github.com/vectorize-io/hindsight/commit/e3efe5dd8b070d00129c5186d111c0bc5f992363)，提交时间为 2026-09-13T14:20:09Z。本轮未安装插件、运行 Hindsight 或修改宿主配置；当前源码不代表所有能力已进入同一发布包，实施时另固定实际发行版本。

## 官方已有什么

| 对象 | 核查结果 | 不能据此声称 |
|---|---|---|
| [coding-agents 统一包][coding] | 多种 Agent 共用核心，包含 Copilot CLI；提供 hooks、会话写回、git 摄取、知识页及配置 | VS Code Copilot 自动获得同等 hooks 能力；全部宿主都能采集完整工具证据 |
| [copilot-cli 专用集成][cli] | 会话和部分子代理启动时召回，agentStop 按配置写回，sessionEnd 最终保存；配置含 retainToolCalls | 已实现每个新任务和采用前刷新；工具配置存在就证明实际 transcript 全覆盖 |
| [VS Code Copilot 集成][vscode] | 配置 .vscode/mcp.json 和 copilot-instructions.md，由 Agent 调用记忆工具 | 已有同等自动 transcript 采集或独立 VSIX |
| [通用 Agent Plugin][portable] | 打包 Skills + MCP，通过 skill 引导工具调用 | 标准包本身提供各宿主的生命周期 hooks |
| [Observations][observations] | 事实归纳、去重、精确引文、随证据更新；默认筛选长期知识，mission 可配置 | 来源独立性、因果支持和本项目所有准入样例已经通过 |
| [Memories 管理][memories] | 原生事实可编辑、停用、恢复并重算派生知识，管理界面显示相关状态 | 原生 curation 自动保留到来源重处理之后；产品只需重复实现编辑界面 |

各上游集成是不同实现，不能混用触发时机、默认值和数据覆盖结论。统一包已有路径、bank、会话写回、git 摄取及配置管理选项；不应描述为完全无范围控制，也不能直接继承它的默认摄取和自动更新行为。

## 已知差异与未验证项

### 分层提取和工具的补充核查

同一提交的[retain说明][retain]及[因果提取源码][causal]包含事实、情境与caused_by关系；[observations][observations]从多条事实归纳模式。[mental models][mental]保存一个问题的长期答案并随材料更新，[reflect][reflect]综合各层知识。这些能力可参与L1–L5提炼，不能把原生类型直接对应某层，也不能将因果字段等同机制已验证。

官方[CLI/Control Plane][cli-tools]已有记忆管理UI和命令行；统一[coding-agents][coding]的usage/diag日志及stats提供工具调用和引用声明统计。可复用它们的基础工具，方法形成、分支使用和结果推动的内容变化按当前产品合同组织；本记录不声称官方没有任何等价扩展。

### 纠正和长期知识

[Memories 文档][memories]明确写道：

> reprocessing a document resets curation

编辑和停用不会改写历史来源文档，重处理会重新提取。该行为与 LessonLoop 要求的“用户控制跨重处理保留”存在具体差异。只有原始 world/experience facts 可直接 curate，observation 的 PATCH 返回 400。核心需保留自己的经验身份、当前修订和来源绑定；直接转发一次原生 PATCH 不足以满足整个生命周期合同。

关于长期价值，[Observations 文档][observations]说明默认规则会过滤短暂状态：

> with ephemeral state filtered out

因此“官方不会筛选长期记忆”不成立。临时指令与长期要求混合、Agent 猜测、重复来源和跨项目条件等仍须用真实材料测试；未找到同名产品字段不能作为功能缺失的证据。

## 扩展与接入能做什么

[OperationValidatorExtension 源码][validator]的 accept_with 可修改 retain 内容及 recall 的 tags、tags_match、tag_groups；on_recall_complete 与 on_reflect_complete 返回 None，接口未承诺可替换最终响应。它可以加强请求过滤和访问限制，不能直接当作覆盖所有结果的通用过滤器。

原生读取还包括 reflect、mental model 和知识页等接口。只包装 recall 不能保证失效经验不再影响综合回答。工作代理使用 LessonLoop API，未验证的原生入口不开放；引擎内部生成若不能限定有效依据并核对来源，就不作为产品输出。正式路由覆盖和生成路径仍待实测。

官方插件直接使用 Hindsight 协议；LessonLoop API 有自己的材料、稳定经验和回执语义。优先复用上游宿主代码，转换必要调用；不承诺换一个地址即可兼容。业务规则位于独立核心，Hindsight 配置及扩展仅留在 MemoryEngine 实现内。

## 后续验证

先固定官方插件、引擎、模型与配置，以临时性、当前适用性、纠正后重处理和原生读取旁路为首批场景。分别记录原生满足、配置后满足、需补充和未验证，再对实际缺口增加代码。正式产品仍保留可替换 MemoryEngine，首期只实现 Hindsight；更换引擎需要迁移和相同合同验收。

架构以[系统架构](../../03-architecture.md)为准，宿主接入见[接口合同](../../04-contracts-and-extensions.md#copilot-适配)，执行门槛见[官方基线与缺口验证](../../05-delivery-and-validation.md#官方基线与缺口验证)。本记录不修改已有 P0 运行证据，也不代表本机产品能力已通过。

产品方向随后收敛为工作经历形成并更新方法，具体见01/02/12。保留这里的已知差异与接口限制，用于决定复用方式；它们不再代替完整产品定位。

[coding]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-integrations/coding-agents/README.md
[cli]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-integrations/copilot-cli/README.md
[vscode]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-integrations/github-copilot/README.md
[portable]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-integrations/agent-plugin/README.md
[observations]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/observations.mdx
[memories]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/api/memories.mdx
[validator]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-api-slim/hindsight_api/extensions/operation_validator.py
[retain]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/retain.md
[causal]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-api-slim/hindsight_api/engine/retain/fact_extraction.py
[mental]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/mental-models.mdx
[reflect]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/developer/reflect.mdx
[cli-tools]: https://github.com/vectorize-io/hindsight/blob/e3efe5dd8b070d00129c5186d111c0bc5f992363/hindsight-docs/docs/sdks/cli.md
