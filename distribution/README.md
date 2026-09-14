# Windows 组件开发工具

这些工具用于构建和验证，尚不是最终安装器。正式包必须包含私有运行时、完整依赖锁、哈希清单、安装/后台/升级/卸载管理和验收报告。

| 文件 | 当前用途 |
|---|---|
| extract-postgres.py | 在构建机通过官方 pg0 解包 PostgreSQL 与 pgvector；pg0 仍写当前用户 .pg0 缓存 |
| database.py | 在明确的 DataRoot 初始化、启动和停止私有数据库，密码从 stdin 接收 |
| download-model.py | 从固定清单下载模型，完整校验大小及 SHA256 后激活 |
| hindsight_server.py | 启动官方引擎并加载固定版本 Schema 兼容层 |
| hindsight_compat.py | 保留原始 JSON Schema，验证嵌套必填、枚举、nullable 和格式 |
| build-bundle.ps1 | 汇集私有运行时、数据库、本地模型与产品构建，生成逐文件摘要 |
| install.ps1 | 验证本地 bundle 清单并复制；开发包必须显式选择 AllowDevelopmentBuild |
| runtime.py | DPAPI、独立数据库初始化及后台 start/status/stop；仍缺完整失败恢复和升级管理 |

`extract-postgres.py` 不随用户安装流程运行。runtime.py 已在中文空格 DataRoot 验证 DPAPI、独立初始化、后台启动、状态和停止；私有 Python 从完整搬迁目录导入 Hindsight 成功。冷启动超过当前 120 秒等待上限，后台后来就绪，启动失败恢复尚需修复。不要把当前开发工具用于其他人的生产数据库。

运行引擎前需在私有数据库 public schema 安装 vector 和 pg_trgm，并配置认证、loopback 地址、固定模型路径与 UTF-8 子进程环境。完整过程和实际发现见[运行记录](../docs/research/2026-09-14-implementation/README.md)。
