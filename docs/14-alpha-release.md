# LessonLoop 0.1.0-alpha.2

Windows x64预览版，用于个人本机试用。复用电脑上符合最低版本的Python、Node.js和PostgreSQL；工作与学习模型使用已有Copilot CLI登录。Copilot CLI需要单独安装并登录。

最低要求为Python 3.11 x64、Node.js 18.14.1 x64、PostgreSQL 15 x64及pgvector 0.5.0、pg_trgm扩展。满足条件直接使用；版本过旧时询问是否升级，缺失时询问是否安装，默认拒绝。具体检测与安装方式见[兼容说明](15-runtime-compatibility.md)。alpha.1仍使用原来的随包运行时，升级到alpha.2需使用新的InstallRoot和DataRoot；原数据保留。

## 安装与启动

从[GitHub Releases](https://github.com/cubika/LessonLoop/releases/tag/v0.1.0-alpha.2)下载install.ps1和SHA256SUMS.txt，核对脚本摘要后，用普通用户PowerShell运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" start
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" configure --allow-root C:\path\to\project --enable-learning
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" agent install
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" doctor
& "$env:LOCALAPPDATA\LessonLoopRuntime\lessonloop.ps1" ui
```

脚本先检查依赖，按需确认，再下载并校验约16MB的程序ZIP。E5和MultiBERT模型在安装时在线下载，已有合格文件或缓存就复用。Python与Node.js安装或升级交给winget；官方安装器可能要求管理员权限。没有winget时会提供官方下载地址。PostgreSQL及扩展不满足条件时，经确认下载独立组件；已有数据库保持原样。安装本身不需要Docker。

也可下载Windows产品ZIP和可选PostgreSQL组件ZIP，校验摘要后解压。在产品目录执行distribution/install.ps1 -Bundle .；若PostgreSQL不在常见安装位置，加-PostgresPath指向包含bin、lib、share的根目录。产品ZIP不含模型或Python、Node.js、PostgreSQL运行时。安装模型需访问对应Release，Python应用依赖需访问PyPI；已下载模型ZIP可用-ModelCache指定目录。不要直接解压到已有安装目录。

安装返回2表示已安装、仍需配置；doctor返回2表示组件、登录或宿主接入尚未全部就绪。首次加载本地模型可能较慢，start返回starting时可再次运行。默认不启用自启或效果回顾；可在页面分别设置。注册后重新打开Copilot CLI，在选定项目中工作。-NonInteractive仅在依赖已满足时可继续，不会自动批准安装或升级。

## 管理

- 自启：lessonloop.ps1 autostart enable；关闭使用autostart disable。
- 暂停新学习和推荐：lessonloop.ps1 configure --disable-learning；已有材料不随之删除。
- 移除宿主接入：lessonloop.ps1 agent remove。其他插件、MCP与共享账号保留；已修改的同名配置不会被强行覆盖。
- 卸载程序：lessonloop.ps1 uninstall。保留数据和凭据。卸载前关闭关联Copilot会话。
- 永久清理：先从doctor读取installationId，然后执行lessonloop.ps1 data purge --confirm <installationId>。只清本产品受控数据和备份，用户另存导出保留。清理后可setup建立空库。

默认数据目录为LOCALAPPDATA/LessonLoop。安装参数InstallRoot、DataRoot和BasePort可指定独立目录与端口；多个测试实例应使用不同目录和端口。

## 本次范围与限制

已提供方法学习、查看/编辑/导出、Copilot有界会话采集与方法准备、样例JSON Connector及效果回顾。真实宿主回填、补证发布和自动演进的局部流程已有验证。

这是alpha，不表示P0–P3正式质量门槛全部通过。跨场景泛化、长期收益、所有故障场景和干净Windows虚拟机矩阵仍待验证。Copilot按会话采集，追问与恢复沿用原关联；需要独立关联时新建Copilot会话。new/continue不再切分任务。采集缺失或截断会报告缺口，长会话用最近窗口学习。

官方provider、检索、原生作业和重排直接复用；删除了未使用的适配封装。持续维护同一Mental Model的delta路线尚未切换：当前产品仍使用隔离作业及独立审查，避免alpha前扩大存储与来源合同。页面是产品方法管理，不是另一个工作流执行器。

本地数据不表示离线推理。首次alpha ZIP未做Windows代码签名；下载后按Release摘要核对。模型与第三方组件许可随包保留。使用体验或问题可在[Issues](https://github.com/cubika/LessonLoop/issues)反馈。
