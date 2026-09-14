# Copilot协议验证记录

日期：2026-09-13。范围：固定Copilot CLI 1.0.83的隔离宿主协议测试。这里保留与当前Agent接入仍有关的预检和hook证据；没有安装正式产品或修改默认Copilot profile。

| 检查 | 结果 | 限制 |
|---|---|---|
| CLI版本与帮助 | 预检通过 | 只证明该二进制及启动选项可用 |
| prompt回填 | 两种prompt hook的内容在首次模型请求前出现 | 仅适用于该版本与合成输入 |
| preToolUse明确拒绝 | 阻止测试目录内view读取 | 不代表所有工具或宿主版本具有相同行为 |
| preToolUse超时 | 继续执行读取，postToolUse和后续模型输入有实际文件结果 | 超时不能作为记忆服务失联时阻止动作的保证 |

测试使用本地脚本模型，共5次请求、0次真实模型调用，没有提供账号凭据。userPromptSubmitted.modifiedPrompt的实际回填与当时读取的官方说明存在差异，具体观察保留在原始报告中。

## 原始报告

- [宿主预检](host-preflight.json)
- [三场景hook报告](host-hooks.json)

当前可运行入口见[Copilot探针](../../../probes/copilot/README.md)。移动代码或更新文档不算重新执行测试；更换CLI版本需要重验。真实工作案例捕获、方法准备、采用、异步回执及用户收益仍待分别验证。
