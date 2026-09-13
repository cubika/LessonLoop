# 发布前验证原型

这是独立运行的 P0 原型，不是可安装的 LessonLoop 产品。数据、进程日志、模型和宿主 profile 都放在工作区 `.p0/`，不使用用户经验库。

这里的三组对照供开发和发布前验证使用，需开发者显式运行，不随产品启动或用户任务自动执行。无需先完成正式安装包，但必须运行核心代码和真实依赖；日常产品只执行用户的当前任务，必要的线索核实不属于三组实验。

## 运行

需要 Windows x64、Node 22.18+ 与 PowerShell。依赖版本在根目录 lockfile 固定；准备脚本从官方地址下载并核对已记录 SHA-256，不注册系统服务。

```powershell
npm ci --ignore-scripts --legacy-peer-deps
./scripts/p0-prepare.ps1
npm run typecheck
npm test
npm run p0:storage
npm run p0:host
npm run p0:host-hooks
```

storage 使用真实 Mem0 3.1.8、Qdrant 1.19.1、Qdrant JS client 1.18.0 与本地 MiniLM q8 嵌入。它验证手写结构样本的存储/筛选/修改/删除/进程重启，不证明提炼质量、中文召回或任务收益。每次启动自己的 Qdrant 实例，结束后停止；如果专用端口已占用则拒绝连接。

host 仅运行隔离 CLI 的 version/help。host-hooks 用真实 Copilot CLI 1.0.83、临时插件目录和本地脚本模型响应探测协议，没有账户凭据或真实推理调用。它只可说明观察到的 hook 行为，不能算真实 Agent 效果。

## 真实模型对照入口

下列命令是开发测试入口，不是用户日常工作步骤。目前真实模型对照未执行；已有存储检查和脚本模型宿主探针不能替代它。

```powershell
$env:LESSONLOOP_MODEL_URL = "http://127.0.0.1:1234/v1"
$env:LESSONLOOP_MODEL = "your-actual-model"
npm run p0:evaluate
```

远程服务需要 HTTPS 和明确配置的 `LESSONLOOP_MODEL_API_KEY`；不要把密钥写进文件。只发送这里的手写测试材料，不读取用户项目或默认 Copilot profile。未配置真实模型时，命令保存 blocked 报告，不用脚本输出代替模型。

入口安排 no_memory、mem0_default、structured_learning 三组，在各自集合/目录执行文件读取、JSON 修改及检查。同一模型用于执行与提炼，固定轮次上限；结构化提炼只接收历史材料，任务答案未注入提取输入。当前仅两组机制样本，结构化支路还不是完整领域准入或核实系统。正式实验需要真实脱敏资料、独立标注、保留集、重复运行和完整成本统计。

## 发现与限制

- 发布的 Mem0 OSS 包会顶层导入未使用的 `better-sqlite3`/`pg`，只配置 Qdrant 与 disableHistory 仍无法在不安装 SQL 包时导入。P0 的 `mem0-imports.mjs` 仅对这两个未使用模块返回抛错实现；Mem0/Qdrant 算法未修改。正式发布需要解决其模块加载边界，不能称原包无适配即通过。
- Qdrant JS client 1.19.0 移除了 Mem0 调用的 search 方法，实际运行失败；本原型固定 1.18.0。
- Transformers 的旧 sharp 传递依赖存在已报告漏洞，原型 override 为 0.35.4；依赖审计在安装时通过。
- 本地嵌入是小型英文模型；测试材料为手写样本。语义真实性和高层提炼不能由 schema 或来源子串检查证明。
- 当前 task runner 只支持测试目录内的有限文件动作，不能代替真实 Copilot harness。默认 Mem0 内部模型用量还需统一采集，当前成本数字不用于宣称优势。

报告写入 `.p0/results/`。已确认结果和未测事项应分别阅读，不从总体 passed 推断所有 P0 项目已经完成。
