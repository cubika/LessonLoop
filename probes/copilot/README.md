# Copilot 协议探针

这里验证固定Copilot CLI的版本参数、prompt回填、工具拒绝和hook超时行为。探针与记忆引擎独立，不启动Hindsight或LessonLoop产品，也不实现方法学习。

## 准备与运行

需要Windows x64、PowerShell和Node.js 18.14.1+，在仓库根目录运行：

```powershell
npm ci --ignore-scripts
./scripts/prepare-copilot-probe.ps1
npm run probe:copilot
npm run probe:copilot-hooks
```

准备脚本下载并核验隔离Copilot CLI 1.0.83，runtime和临时profile在.local-validation/copilot/，不修改用户默认Copilot。

probe:copilot执行version/help预检；probe:copilot-hooks启动真实CLI但使用本地脚本模型，检查上下文回填、明确拒绝和超时继续三个场景。没有账号凭据或真实模型调用，不能据此判断Agent正确使用方法或任务收益。

## 报告与产品验收

报告在.local-validation/copilot/results/，历史范围见[2026-09-13记录](../../docs/research/2026-09-13-p0/README.md)。更换CLI版本需重新准备和验证，移动脚本路径不算重新完成实测。

当前产品的getGuidance回填、会话采集、反馈和异步回执按[Agent接入](../../docs/04-contracts-and-extensions.md#copilot-适配)单独验收，结果见实现计划。这里的旧版协议探针不覆盖当前三工具或会话学习流程。
