# Copilot 采集复用

采集基础来自 [@vectorize-io/hindsight-coding-agents 0.4.2 发行包](https://registry.npmjs.org/@vectorize-io/hindsight-coding-agents/-/hindsight-coding-agents-0.4.2.tgz)，使用 [MIT 许可](hindsight-LICENSE)。包内 `dist/copilot-stop-hook.js` 的 SHA256 为 `c6b3694ce0bebdfcc469b65a1ce74d0131c33445ea4c515378b7a3d51c7ab9fa`。

[upstream.ts](../src/adapters/copilot/upstream.ts) 保留其中 `core/jsonl.ts` 的分块读取、UTF-8 解码，以及 `core/transcript-copilot.ts` 的消息角色映射和 `core/transcript-util.ts` 的记忆标签剥离。该版本未导出这些独立模块，所以随产品保留最小源码适配，不安装包含所有宿主与运行时的整包。

本地改动是异步使用已校验的文件句柄、限定读取快照、返回完整行的字节位置，并延后处理末尾半行。产品层另外校验会话和目录身份，排除子代理及 LessonLoop 派生内容，补充官方消息 reader 未保留的工具事件和回填回执。Copilot 正常回复和工具结果仍作为材料。

官方 retain cursor 针对单个原生会话文档执行 replace/append；失败后的整篇替换不符合产品材料删除与增量提交语义，因此保留产品采集检查点。任务边界由核心处理，关闭与结束事件在一次数据库事务内提交，不从宿主停止推断任务成败。材料、工具观察和效果事件复用核心幂等及容量控制，hook 不再保存三份去重清单。本地 JSON 保存检查点、工具关联、注入回执、事件首次时间及待发送的停止／结束回执；首次时间确保 hook 和 transcript 两条路径使用相同提交内容。中断后先补交边界，未完成的采集记为缺口，后续读取继续补收可用材料。

升级后重新打开工作会话。旧版适配器的本地任务状态不导入新协议；历史来源与任务仍保留在核心。
