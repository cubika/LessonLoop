# P0 实现与运行记录

本轮从 W01、W02、W03/W04 最小路径开始。当前仍在开发，P0–P3 均未宣布通过；安装包尚不可交付。

## 已实现并检查

- 新增产品领域 Schema、来源指纹、方法结构、支持资格与分支准备。
- PostgreSQL 独立 lessonloop schema、迁移、单写协调、CAS、可靠接收和跨重启幂等。
- 官方 Hindsight SDK 薄适配，关联原生 retain/Mental Model 操作，产品候选校验与发布屏障。
- 最小认证 loopback API、开发 CLI 和方法库页面。

TypeScript 检查、构建及 28 个现有/新增单元测试通过。真实 PostgreSQL 集成测试覆盖迁移、单实例、幂等、冲突、来源角色、任务观察与重启。它们只证明对应工程行为。

后续新增 Copilot 事件适配与产品 MCP 初版。真实 Copilot CLI 1.0.84-5 在独立验证目录中成功执行 userPromptTransformed、postToolUse、sessionEnd；宿主事件记录确认产品 lead 经 modifiedTransformedPrompt 回填，并关联核心 task/methodUse。当前仍未验证完整材料捕获、显式续用及安装注册。领域与协议单元测试增至 30 项。

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

官方源码依据：[结构化提取](https://github.com/vectorize-io/hindsight/blob/v0.9.2/hindsight-api-slim/hindsight_api/engine/reflect/agent.py)、[原文 chunks](https://github.com/vectorize-io/hindsight/blob/v0.9.2/hindsight-api-slim/hindsight_api/engine/retain/fact_extraction.py)、[前置检索过滤](https://github.com/vectorize-io/hindsight/blob/v0.9.2/hindsight-api-slim/hindsight_api/engine/sql/postgresql.py)。

## 仍需完成

真实执行的生成文件案例已生成 1 个方法及相关经验；当前上下文未知时返回 lead，绑定实际 fixture 观察后返回 1 个诊断步骤，中文查询找到该英文方法。报告仍标 partial_evidence：未验证整个任务迁移、宿主自动采集/回填及 P0 全部退出条件。

P1 完整入口、P2 演进与生命周期、P3 Connector/回顾/完整发行和正式质量报告尚未通过。无预装环境安装、升级回滚、永久清理以及 05/09 的冻结质量/收益门槛不能以当前工程测试替代。

本地完整报告保存在 .local-validation/results，包含失败运行；发布证据不得只保留成功部分。
