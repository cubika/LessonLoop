# Windows 组件开发工具

alpha.2优先复用系统运行时；最低版本、确认流程和安装用法见[安装说明](../docs/14-alpha-release.md)。build-bundle.ps1仍用于准备开发组件，用户发行包由package-release.py生成。

| 文件 | 当前用途 |
|---|---|
| extract-postgres.py | 在构建机通过官方 pg0 解包 PostgreSQL 与 pgvector；pg0 仍写当前用户 .pg0 缓存 |
| database.py | 在明确的 DataRoot 初始化、启动和停止私有数据库，密码从 stdin 接收 |
| download-model.py | 从固定清单下载模型，完整校验大小及 SHA256 后激活 |
| hindsight_server.py | 启动官方引擎并加载固定版本 Schema 兼容层 |
| hindsight_compat.py | 保留原始 JSON Schema，验证嵌套必填、枚举、nullable 和格式 |
| build-bundle.ps1 | 汇集私有运行时、数据库、本地模型与产品构建，生成逐文件摘要 |
| bootstrap.ps1 | 发布时生成install.ps1，检查已有依赖、按需确认安装并下载程序；模型由本地安装脚本继续准备 |
| dependencies.ps1 | 检测最低版本、选择已有运行时，缺失或过旧时询问用户 |
| package-release.py | --release-dir生成小程序ZIP、独立模型ZIP、可选数据库ZIP、install.ps1和SHA256SUMS.txt |
| model_assets.py | 校验模型清单，复用当前/旧版本文件或缓存ZIP，缺失时在线下载 |
| install.ps1 | 验证本地 bundle 清单并复制；开发包必须显式选择 AllowDevelopmentBuild |
| runtime.py | DPAPI、独立数据库初始化、后台 start/status/stop/doctor；支持缺失组件恢复及兼容升级/回滚，完整发行生命周期待验收 |

`extract-postgres.py` 不随用户安装流程运行。runtime.py 已在中文空格 DataRoot 验证 DPAPI、独立初始化、后台启动、状态和停止；私有 Python 从完整搬迁目录导入 Hindsight 成功。冷启动超时会保留初始化中的组件，可再次运行 start 等待；核心单独退出、私有数据库退出后的恢复及重复停止已在隔离安装验证。不要把当前开发工具用于其他人的生产数据库。

运行引擎前需在私有数据库 public schema 安装 vector 和 pg_trgm，并配置认证、loopback 地址、固定模型路径与 UTF-8 子进程环境。完整过程和实际发现见[运行记录](../docs/research/2026-09-14-implementation/README.md)。


兼容版本管理正在实现：bundle.py 校验清单、Windows 路径和复制后的字节；runtime.py update/rollback 仅接受相同产品 Schema、协议、Hindsight 和 PostgreSQL 组件版本。切换前停止归属组件、拒绝未终结作业，备份整个数据库并执行只读兼容检查；兼容回滚沿用当前数据库，不恢复旧备份覆盖后来控制。中文空格 DataRoot 的真实兼容升级已通过，新核心/引擎均 ready，升级后设置写入成功；兼容回滚也已实测通过，升级后设置修订保留且数据库未恢复旧备份；故障中断恢复矩阵和最终发行字节仍需实测，当前包保持 releaseReady=false。
