# 资料核验记录

日期：2026-09-12。本文记录当时 Mem0/Qdrant 原型路线的官方文档与固定提交源码核验，运行结果另行保存。当前目标架构见[系统架构](../../03-architecture.md)，本文不作为 Hindsight 的能力或实现证据。

## Mem0 OSS

核验基线为 `c7ee362aff94a369af70f13f2b4f853f6793ff4c`，提交日期 2026-09-11；该树的 TypeScript package.json 标记为 `mem0ai 3.1.8`。结论只适用于所核实的源码，实施时还需固定实际包与依赖版本。

| 官方来源 | 本次确认的事实 |
|---|---|
| [OSS 算法升级文档](https://docs.mem0.ai/migration/oss-v2-to-v3) | 文档写有 “Single-pass ADD-only”，没有自动 UPDATE/DELETE；不是五层提炼声明 |
| [infer:false 路径](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/memory/index.ts#L844) | 每个非 system message 单独 createMemory；绕过默认提取 |
| [默认 payload 映射](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/memory/index.ts#L1028) | call metadata 和少数提取字段被写入；额外 prompt 字段不自动持久化 |
| [候选构建](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/memory/index.ts#L1550) | `const candidates = semanticResults`；keyword 得分没有独立加入候选，expiry 在此后筛 |
| [更新路径](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/memory/index.ts#L1951) | metadata-only 仍可能调用 embed；合并 metadata，没有应用级 CAS |
| [过滤转换](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/memory/index.ts#L2147) | AND 逐条件 Object.assign，重复字段条件存在覆盖风险；限定规范化过滤 |
| [Qdrant list](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/vector_stores/qdrant.ts#L457) | 单次 scroll，未传递或返回 next-page offset；不能视作完整分页导出 |
| [LLM factory](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0-ts/src/oss/src/utils/factory.ts#L108) | 没有内置 Copilot provider；应用使用独立 ExtractionModel |

当时的原型使用 Mem0 OSS，不依赖 Platform Dream。托管平台提供的合并、抽象或自动纠错能力，不能计入该原型的实现结果。

## Qdrant 与运行配置

Qdrant 官方文档仓库核验提交为 `c341e980866afc423e7cb49da7d681e04f3b55ae`：payload 字段可建索引；keyword 是完整值精确匹配；text 使用分词处理，文本过滤不等于通用 BM25 排序。Mem0 源码的 `disableHistory` 分支构建 DummyHistoryManager。

该原型数据层只使用 Qdrant，须显式配置 Qdrant provider 并关闭 Mem0 history。本次静态核验未测试管理 collection 持久化、SQLite 数据文件或重启行为；后续小样本结果见 [P0 实测](../2026-09-13-p0/README.md)。

## 保存的证据

同目录 JSON 保存来源 URL、抓取时间及原文 hash；部分文件包含有限源码摘录与行号，不包含完整上游源码或图像。

- [Mem0 memory 源码摘录](mem0-current-memory.json)
- [Mem0 Qdrant adapter 源码摘录](mem0-current-qdrant.json)
- [Mem0 包版本摘录](mem0-current-package.json)
- [Mem0 main 查询元数据](mem0-repo-main.json)
- [Mem0 OSS 算法升级文档元数据](mem0-oss-migration.json)
- [Mem0 history 关闭路径](mem0-history-config.json)
- [Qdrant payload 索引依据](qdrant-payload.json)
- [Qdrant 精确和文本过滤依据](qdrant-text-filtering.json)
- [Qdrant collection 依据](qdrant-collections.json)

## Copilot CLI 包装机制

2026-09-13 补充读取 GitHub 官方 [Copilot CLI 插件创建文档](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating)与 [hooks 使用文档](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)。文档确认插件可包含 skills、MCP 配置和宿主 hooks；Agent Plugins 1.0 使用根 plugin.json、mcp.json，以及 com.github.copilot 下的专属组件。这些资料说明插件怎样组织。后续 [P0 宿主测试](../2026-09-13-p0/README.md)已验证部分时序，完整 hook 数据覆盖、自动回填和安装兼容性仍需验收。

日常文档校验见[仓库检查入口](../../../README.md#在源码中运行检查)，生成报告不属于这批历史证据。版本锁定、写入读回、前置过滤、超时隔离、删除和重启须按[原型合同](../../05-delivery-and-validation.md#mem0-原型合同)实测。
