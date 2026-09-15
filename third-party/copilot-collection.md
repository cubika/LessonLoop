# Copilot 采集复用

采集基础来自 [@vectorize-io/hindsight-coding-agents 0.4.2 发行包](https://registry.npmjs.org/@vectorize-io/hindsight-coding-agents/-/hindsight-coding-agents-0.4.2.tgz)，使用 [MIT 许可](hindsight-LICENSE)。包内 `dist/copilot-stop-hook.js` 的 SHA256 为 `c6b3694ce0bebdfcc469b65a1ce74d0131c33445ea4c515378b7a3d51c7ab9fa`。

[upstream.ts](../src/adapters/copilot/upstream.ts) 保留其中 `core/jsonl.ts` 的分块读取、UTF-8 解码，以及 `core/transcript-copilot.ts` 的消息角色映射和 `core/transcript-util.ts` 的记忆标签剥离。该版本未导出这些独立模块，所以随产品保留最小源码适配，不安装包含所有宿主与运行时的整包。

本地改动是异步使用已校验的文件句柄、限定读取快照、返回完整行的字节位置，并延后处理末尾半行。产品层另外校验会话和目录身份，排除子代理及 LessonLoop 派生内容，补充官方消息 reader 未保留的工具事件和回填回执。Copilot 正常回复和工具结果仍作为材料。

每个 Copilot 会话通过已有 startTask 幂等绑定一个 taskRef。回复停止、退出和恢复会话不切分任务；新建 Copilot 会话才建立新关联。已删除任务边界 RPC、new/continue 指令、停止状态、边界补交和运行时观察副本。taskRef 只用于会话来源与方法反馈关联，不代表一个独立工作主题。

采集只从 transcript 提交原始 user、agent、tool 材料；postToolUse 和 finalMessage 不再另行入库，避免两条路径的去重与时间同步。本地只保存字节检查点、工具名称关联和注入回执。失败不推进检查点，下个 prompt、agentStop 或 sessionEnd 重读并复用核心幂等。缺失、截断或无法关联的工具记录报告采集缺口。官方 retain cursor 的整篇 replace 会改变产品来源与删除语义，未引入。

长会话保留全部已接收来源，后台学习使用最近至多192段、128 KiB的窗口。WorkView 是当前窗口摘要，允许替换旧摘要，不承诺为同一会话保存多个主题案例。同会话窗口保持同一来源族和发布顺序，不能作为独立证据重复计数。指导按每条新提示重新检索；会话任务使用24小时空闲期限，收到新的宿主回调后恢复有效。

升级后重新打开工作会话。旧版适配器的本地任务状态不导入新协议；历史来源与任务仍保留在核心。
