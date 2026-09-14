# Copilot 协议探针

这里保留与记忆引擎无关的宿主验证：固定 Copilot CLI 版本的启动参数、prompt 回填、工具拒绝和 hook 超时行为。Mem0/Qdrant 原型已移除，探针不启动记忆服务。

## 准备与运行

需要 Windows x64、PowerShell 和 Node.js 22.18+。从仓库根目录运行：

```powershell
npm ci --ignore-scripts
./scripts/prepare-copilot-probe.ps1
npm run probe:copilot
npm run probe:copilot-hooks
```

准备脚本只下载并核验隔离的 Copilot CLI 1.0.83，运行时与临时 profile 存放在 `.local-validation/copilot/`。不安装或修改用户默认 Copilot。

`probe:copilot` 只执行 version/help 预检。`probe:copilot-hooks` 启动真实 CLI，但推理响应来自本地脚本模型；三个场景分别验证上下文回填、明确拒绝和超时继续执行。它不使用账号凭据或真实模型，不能证明 Agent 正确采用经验或任务收益。

报告写入 `.local-validation/copilot/results/`。历史结果见[2026-09-13 记录](../../docs/research/2026-09-13-p0/README.md)，迁移代码保留当时的协议标记，路径迁移本身不算重新完成宿主实测。更换 CLI 版本要重新准备和验证。
