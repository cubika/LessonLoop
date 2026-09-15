# LessonLoop 0.1.0-alpha.1

首个Windows x64预览版，用于个人本机试用。包含私有Node、Python、PostgreSQL、Hindsight和本地嵌入/重排模型；工作与学习模型使用已有Copilot CLI登录。Copilot CLI需要单独安装并登录。

## 安装与启动

从[GitHub Releases](https://github.com/cubika/LessonLoop/releases/tag/v0.1.0-alpha.1)下载Windows ZIP和SHA256SUMS.txt，核对ZIP的SHA256后解压。不要把压缩包直接解压到已有安装目录。使用普通用户PowerShell，项目路径请替换为实际目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\distribution\install.ps1 -Bundle .
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" start
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" configure --allow-root C:\path\to\project --enable-learning
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" agent install
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" doctor
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" ui
```

安装返回2表示已安装、仍需配置；doctor返回2表示组件、登录或宿主接入尚未全部就绪。首次加载本地模型可能较慢，start返回starting时可再次运行。默认不启用自启或效果回顾；可在页面分别设置。注册后重新打开Copilot CLI，在选定项目中工作。

可选择下载同一Release中的install-alpha.ps1，它会下载固定版本、核对ZIP摘要，再执行安装。手动解压安装也不需要管理员或Docker。

## 管理

- 自启：lessonloop.ps1 autostart enable；关闭使用autostart disable。
- 暂停新学习和推荐：lessonloop.ps1 configure --disable-learning；已有材料不随之删除。
- 移除宿主接入：lessonloop.ps1 agent remove。其他插件、MCP与共享账号保留；已修改的同名配置不会被强行覆盖。
- 卸载程序：lessonloop.ps1 uninstall。保留数据和凭据。卸载前关闭关联Copilot会话。
- 永久清理：先从doctor读取installationId，然后执行lessonloop.ps1 data purge --confirm <installationId>。只清本产品受控数据和备份，用户另存导出保留。清理后可setup建立空库。

默认数据目录为LOCALAPPDATA/LessonLoop。安装参数InstallRoot、DataRoot和BasePort可指定独立目录与端口；多个测试实例应使用不同目录和端口。

## 本次范围与限制

已提供方法学习、查看/编辑/导出、Copilot有界会话采集与方法准备、样例JSON Connector及效果回顾。真实宿主回填、补证发布和自动演进的局部流程已有验证。

这是alpha，不表示P0–P3正式质量门槛全部通过。完整L2–L5泛化、长期收益、所有故障场景和干净Windows虚拟机矩阵仍待验证。自动任务边界有局限，可用/lessonloop new或continue明确覆盖。采集超预算会报告缺口，不承诺无限历史。

官方provider、检索、原生作业和重排直接复用；删除了未使用的适配封装。持续维护同一Mental Model的delta路线尚未切换：当前产品仍使用隔离作业及独立审查，避免alpha前扩大存储与来源合同。页面是产品方法管理，不是另一个工作流执行器。

本地数据不表示离线推理。首次alpha ZIP未做Windows代码签名；下载后按Release摘要核对。模型与第三方组件许可随包保留。使用体验或问题可在[Issues](https://github.com/cubika/LessonLoop/issues)反馈。
