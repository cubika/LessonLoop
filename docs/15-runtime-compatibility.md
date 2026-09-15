# 依赖与版本兼容

alpha.2安装器先检测电脑上已有的运行时。版本和必要能力满足要求就直接使用；过旧时询问是否升级，缺失时询问是否安装。拒绝或直接回车会停止安装。非交互模式缺少依赖时返回错误，不会代替用户确认。

| 组件 | 最低要求 | 使用方式 |
|---|---|---|
| Python | 3.11 x64，具备venv和pip | 复用系统解释器，在LessonLoop目录创建.venv，安装应用依赖 |
| Node.js | 18.14.1 x64 | 复用检测到的可执行文件 |
| PostgreSQL | 15 x64 | 复用程序，在LessonLoop的DataRoot中建立独立数据库 |
| pgvector | 0.5.0 | 所选PostgreSQL必须具备对应扩展文件；还需pg_trgm |
| Copilot CLI | 已测1.0.84-6 | 用户自行安装并登录，其他版本通过认证和协议检查后可尝试 |
| PowerShell | Windows PowerShell 5.1或7 | 宿主注册使用系统Windows PowerShell |

Python会从PATH、py启动器、常见安装目录和uv目录查找，激活venv时使用其基础解释器。Node.js从PATH及常见安装目录查找；PostgreSQL还会检查此前下载的LessonLoop组件。可用-PythonPath、-NodePath指定可执行文件，用-PostgresPath指定PostgreSQL根目录。安装记录保存实际使用的绝对路径。

Python和Node.js需安装或升级时，确认后调用winget的官方包。winget不可用时会给出官方下载地址。PostgreSQL过旧或缺少扩展时，确认后安装独立的PostgreSQL 18.1.0及pgvector 0.8.5组件，原有服务和数据目录不变。再次安装会复用已下载且检查合格的组件。

Python应用依赖装在产品.venv里，不写入系统site-packages。当前固定Hindsight 0.9.2、Copilot SDK 1.0.13及ONNX等直接依赖，详见[Python依赖](../config/python-requirements.txt)。首次安装需要连接PyPI并下载对应Python版本的wheel；某个新Python版本若尚无依赖wheel，安装会报告具体错误。达到版本下限不代表所有未来版本都已实测。

Python下限来自[Hindsight 0.9.2](https://pypi.org/pypi/hindsight-api-slim/0.9.2/json)和[Copilot SDK 1.0.13](https://pypi.org/pypi/github-copilot-sdk/1.0.13/json)的Requires-Python元数据。最低版本和已测组合分别记录在[组件配置](../config/components.json)。doctor报告所选路径与Copilot版本；未测试版本不会仅因版本号被拒绝。

PostgreSQL保存Hindsight的记忆和检索数据，以及LessonLoop的方法、案例与用户设置。两者使用独立schema，共用LessonLoop自己的数据库进程。复用PostgreSQL程序不等于连接、升级或迁移电脑上的其他数据库。

主产品ZIP约16MB，只含核心、Node应用依赖、安装脚本和配置。E5嵌入模型约281MB、MultiBERT重排模型约104MB，由安装脚本在线下载；PostgreSQL也是独立下载项。电脑上已有校验合格的模型就直接复用，升级时从旧版本复制，避免重复下载。

模型ZIP按摘要缓存到LOCALAPPDATA/LessonLoopComponents/model-downloads，下载中断可重新运行安装器；完成下载的组件会复用，未完成的组件重新下载。手动下载模型ZIP后，可用-ModelCache指向存放ZIP的目录。安装和升级在文件校验通过后才激活，日常启动不会下载模型。

文件清单与下载资产均有SHA256校验。首次完整安装仍需取得约385MB模型；改为脚本下载会缩小入口包，不会让必需的模型数据消失。Python应用依赖另由pip下载。安装器检查程序、模型与初始数据库所需空间；缓存、临时解压和后续数据也会占用空间。卸载移除当前安装的模型文件，下载缓存保留，可手动删除model-downloads目录回收空间。

默认端口为19431（核心）、19432（数据库）、19433（引擎），冲突时可通过BasePort更换。卸载LessonLoop保留系统Python、Node.js和外部PostgreSQL，也保留用户数据；永久清理数据是单独命令。

alpha.1使用随包运行时，保持原发布内容。alpha.1到alpha.2的运行时策略变化暂不支持原地update；试用alpha.2需选择新的InstallRoot、DataRoot，原安装数据保留。
