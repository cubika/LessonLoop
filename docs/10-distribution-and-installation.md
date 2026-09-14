# LessonLoop 发布与本地运行方案

日期：2026-09-14。状态：发布设计，安装器、发行包和相关 CLI 尚待实现。

## 发布目标

LessonLoop 是面向个人的本地经验服务。用户在普通 PowerShell 中执行一条 irm 安装命令，即可获得 CLI、Web UI、后台服务和所需运行组件。安装器下载固定版本产物，校验后安装到当前用户目录，并引导完成模型登录和工作代理接入。

默认发行包不要求用户安装 Docker、Python、PostgreSQL、Node.js 或从源码运行 npm/pip。运行时和记忆引擎依赖由发行包管理。用户已有的 Copilot CLI 是工作宿主；模型调用使用现有 Copilot 订阅，不要求独立模型 API key，也不购买记忆云服务。

首个发布目标是 Windows x64、普通用户权限、Windows PowerShell 5.1 或 PowerShell 7。其他系统和架构在有对应构建与安装验收后再公布，不把跨平台源码可运行当成发行包支持。

LessonLoop 核心、记忆引擎、数据库及本地模型由同一个安装器和后台管理进程统一管理。组件可以独立构建和缓存，用户通过同一套命令安装、启动、诊断与更新。关闭安装终端或 Web UI 后，后台继续运行；关机或注销期间不处理任务。

默认记忆引擎选择 Hindsight 自托管，经 MemoryEngine 接口与核心连接。模型提供方式、工作代理和记忆引擎分别配置，替换其中一项不改变其他接入。选型依据见[记忆引擎调研](research/2026-09-14-memory-selection/README.md)。正式发布地址在首个发行版本确定后公布。

## 部署组成与职责

发行包分为安装管理、产品核心和引擎组件。安装管理负责版本与进程，产品核心负责经验规则和用户接口，引擎组件负责提取、归纳及检索。各组件的存储与协议兼容范围写入同一份发行清单。

| 组件 | 职责 |
|---|---|
| PowerShell 安装器 | 平台预检、固定版本下载、摘要校验、安装锁和维护入口 |
| 后台管理进程 | 管理数据库、引擎与核心的启动顺序、健康检查、停止及恢复 |
| 核心 API 与 CLI | 经验准入、适用性、纠正和删除规则；配置、诊断与运行管理 |
| Web UI | 经验浏览、来源查看、修改与学习状态，通过同一核心 API 操作 |
| MemoryEngine 适配器 | 对接 Hindsight 等引擎，映射来源、异步作业、候选与迁移能力 |
| 模型 provider | 通过现有 Copilot 订阅执行推理，嵌入与重排由独立本地模型承担 |
| AgentAdapter 与 Connector | 分别接入工作代理和外部材料来源，共享核心服务与用户授权 |

安装、运行、更新和卸载遵循同一生命周期：先校验和准备组件，再检查数据兼容与服务健康，最后激活版本。程序目录与经验数据分离，模型登录及代理注册分别报告状态。普通卸载保留数据，永久清理使用独立维护操作。

## 用户入口与状态

正式发布时给出以下形式的命令。尖括号是待替换占位符，当前不是可执行的 LessonLoop 下载地址。

```powershell
irm 'https://github.com/<owner>/<repo>/releases/download/<release-tag>/install.ps1' | iex
```

固定版本脚本作为同一 GitHub Release 的资产发布，只安装其内置清单对应的版本，不从 latest 分支拼装依赖。选择 release asset 入口是为了在组件构建和清单生成后，才生成内嵌清单摘要的最终脚本；避免让源码 tag 预先包含尚未构建产物的摘要。需要指定目录或无交互执行时，发布说明同时提供下载脚本后调用的方式；以下参数为待实现合同：

```powershell
# install.ps1 已由发布页提供的固定地址下载并核对版本。
# 路径仅示意；自定义目录必须属于当前用户且通过权限检查。
& ./install.ps1 -InstallRoot 'D:/Apps/LessonLoop' -NonInteractive
```

同版脚本还设计 -Uninstall 和 -PurgeData 两个独立维护模式，可在 launcher 已删除后使用；它们按稳定安装记录定位目标，下载/校验必要的清理工具，不安装或启动正常服务。-PurgeData 仍要求显式确认数据范围，非交互调用须给出明确的数据根与确认参数，不能用默认路径猜测。

irm/iex 入口的信任来自用户选择的发布地址及 HTTPS。bootstrap 内嵌 release manifest 的 SHA-256，再校验每个组件的摘要；不能把“从相同地址下载一个 hash 文件”描述成发布者身份签名。禁止自动关闭 TLS 校验、永久修改执行策略或绕过系统拦截。企业策略不允许远程脚本时，提供同版 zip 与本地脚本的安装说明。

安装器完成后显示四项独立状态：

| 状态项 | 可以报告成功的条件 |
|---|---|
| 程序安装完成 | 清单与组件校验通过，CLI 可启动，版本解析正确 |
| 本地服务可用 | 核心、引擎和数据库实际健康，认证 API 与静态 UI 可访问 |
| 模型可用 | 同用户 Copilot 登录正常，隔离的小型结构化调用成功；本地嵌入/重排可运行 |
| 工作代理已接入 | 插件已注册并被宿主识别；自动回填等能力按适配器分别诊断 |

没有 Copilot 登录时可以完成本地程序安装，但显示“模型待登录，学习暂不可用”；缺少工作宿主时显示“代理待接入”。两者不能变成“全部就绪”。小型模型探测只使用固定无私有信息样本，不扫描历史工作会话。

首次 setup 处理登录、知识集合和采集范围。检测到受支持的 Copilot 时可提供对应接入，保留已有选择和显式关闭项。安装不自动导入所有历史、扫描所有仓库或授予 Connector 全量读取权限。

下面是拟提供的统一 CLI，不代表当前 package.json 已有这些命令：

| 命令 | 用途 |
|---|---|
| lessonloop setup | 首次配置模型、知识集合与工作代理；缺登录时引导正常认证 |
| lessonloop status / doctor | 分开报告组件版本、服务、登录、检索与代理能力，不把部分可用汇总成全绿 |
| lessonloop start / stop / restart | 管理当前用户的后台组件；重复调用幂等 |
| lessonloop ui | 打开已运行服务的本地界面；默认不另外创建后台实例 |
| lessonloop agent install/remove/status <agent> | 管理指定工作代理接入，不改变所选模型或记忆引擎 |
| lessonloop model configure/status <provider> | 管理模型使用方式，例如 Copilot 订阅 |
| lessonloop memory status/migrate <engine> | 查看或显式迁移记忆引擎；普通升级不切换产品 |
| lessonloop autostart enable/disable | 当前用户登录后自动启动；首次默认关闭，用户启用后升级保留 |
| lessonloop update --version <version> | 更新固定版本整套组件，经检查后切换 |
| lessonloop rollback --version <version> | 仅在数据格式和用户控制记录兼容时回退程序 |
| lessonloop uninstall | 停止并移除本产品程序与接入，保留经验和配置 |
| lessonloop data purge | 单独确认后清理指定数据目录及本产品管理备份，不等同普通卸载 |

## 发行产物与依赖

采用“小 bootstrap + 平台组件包”的发行方式。默认安装一次完成所需组件；拆包用于复用缓存与缩小升级下载，不让用户逐项部署。安装过程中允许下载清单声明的组件，之后正常启动不得临时下载未声明 runtime 或模型。

| 产物 | 内容 | 构建与兼容要求 |
|---|---|---|
| install.ps1 | 平台、权限、目录预检；下载和校验；安装锁；调用安装管理逻辑 | 与 tag 对应，嵌入清单摘要；支持干净 Windows PowerShell 5.1/7 |
| release-manifest.json | 产品版本、平台、组件 URL/大小/摘要、许可、schema 与协议兼容范围 | 所有依赖固定版本；不在用户端访问 main/latest 或自由升级依赖 |
| lessonloop-windows-x64-<version>.zip | 核心、CLI、Web UI、受支持的 AgentAdapter、MCP bridge、私有 Node/runtime 与已构建依赖 | 不要求用户运行 npm install；包含正式 Copilot SDK 所需的受支持组件 |
| hindsight-windows-x64-<component-version>.zip | 私有 Python 环境、Hindsight 固定版本及依赖、数据库启动管理组件 | CI 提前构建并验证原生依赖，不在安装机上运行 pip 源码编译 |
| postgres-windows-x64-<component-version>.zip | 私有 PostgreSQL 二进制、已验证 pgvector/必要检索扩展、许可说明 | 普通用户运行独立实例；不注册系统级数据库服务，不复用或修改用户已有数据库 |
| models-<profile>-<revision>.zip | 本地多语言 embedding/reranker 模型、配置、校验与许可 | 模型可免费本地使用与再分发；固定 revision，记录硬件与语言能力 |
| 校验、许可与验收清单 | 各组件来源、第三方许可/SBOM、安装及质量报告索引 | 发布页列出实际支持的平台、下载大小、磁盘与内存需求、已知限制 |

组件命名为发布约定，具体版本和下载大小以首次构建结果填写。模型权重可以使用经许可的独立上游不可变资源，但必须列入固定清单、验证摘要并缓存；不允许首条 recall 才无提示联网下载。

Hindsight 默认首选仍需通过发行可行性检查。其官方支持 Windows/私有部署不等于 LessonLoop 已有可再分发的完整组件包。特别要验证 Python 原生依赖、PostgreSQL 扩展、模型许可与多语言检索。pg0 可用于开发试验；正式持久经验默认采用本产品管理的完整 PostgreSQL 实例，不把上游开发模式直接宣称为生产支持。

中文关键词能力单独声明。只装 pgvector 和英文全文配置不能算中文全文检索完成；需要验证目标包中实际可用的分词/检索后端。若仅支持跨语言向量召回，诊断和发布能力必须如实标注，产品必测项不允许靠“已安装”跳过。

若 Hindsight 的免费 Windows 无管理员发行包无法通过这些检查，应阻止该配置发布并重新评估后端。不能把同一条 irm 命令改成要求用户另付云服务费、手工装 Docker，或静默退回 Mem0 继续报成功。开发者可选外部引擎模式不属于默认安装验收。

## 文件布局与配置所有权

默认 InstallRoot 为当前用户 LOCALAPPDATA 下的 LessonLoopRuntime，DataRoot 为 LOCALAPPDATA 下的 LessonLoop。两者物理分离，卸载代码不删除经验。

| 路径 | 作用 |
|---|---|
| InstallRoot/bin | 稳定 CLI launcher、宿主 hook/bridge 入口；只向用户 PATH 添加这一项 |
| InstallRoot/versions/<version> | 该产品版本的只读代码与组件锁；不放用户数据 |
| InstallRoot/components/<component>/<version> | 校验后的私有 runtime、后端和模型；多版共享时记录引用 |
| InstallRoot/active.json | 当前激活版本、组件清单、协议版本与安装身份；原子替换 |
| InstallRoot/staging/<install-id> | 未激活的下载/解包与检查；失败可以清理，不碰旧版本 |
| DataRoot/config | 配置、范围、适配绑定和凭据引用；秘密保存在当前用户凭据设施 |
| DataRoot/storage | 领域控制状态与引擎数据；同实例独立 schema 按适配器合同管理 |
| DataRoot/run | 当前实例身份、端口定位、进程启动时间与受限访问的运行信息 |
| DataRoot/logs / cache | 有大小与保留期的诊断日志、可重建缓存，不记录认证秘密 |
| DataRoot/backups | 明确标记 schema、版本和删除控制信息的恢复产物 |

全部路径从安装记录解析，不依赖当前仓库或启动目录。路径带空格、中文用户名和不同盘符必须测试。目录不允许位于系统目录或其他用户数据树；解压拒绝绝对路径、上跳路径和逃出 staging 的链接。递归清理前检查规范化后的绝对路径、安装身份与目录所有权。

自定义 InstallRoot 写入当前用户 LOCALAPPDATA 下的稳定安装定位记录；后续 update/uninstall 和安装器重跑先读取它，不能在默认目录创建第二套安装。DataRoot 默认不随代码安装目录改变，改变数据位置属于单独迁移。

不覆盖用户已有 Node/Python/PostgreSQL，不修改机器 PATH。已有同名 lessonloop 命令或安装目录身份不符时显示冲突并停止，不接管其他程序。升级保留配置和显式关闭项；配置默认值迁移有版本，不靠新版本模板覆盖用户文件。

LessonLoop 自建的 API、数据库和 Connector 凭据使用安装身份限定的命名空间，例如 LessonLoop/<install-id>/<purpose>。普通卸载随保留数据保留恢复所需凭据，永久清理才删除该安装登记拥有的凭据；共享 Copilot/gh 登录永不归安装器所有，不能删除或复制到发行包。

## 本地进程与三种接入抽象

用户看到一个 LessonLoop 服务。内部由当前用户的后台管理进程按依赖顺序启动私有数据库、Hindsight 与核心 API，必要时管理本地模型进程。每个 DataRoot 仅一个管理实例。启动使用隐藏窗口与正确的进程生命周期管理，不依赖安装终端中的 PowerShell Job；关闭终端不结束服务。

核心 API 只监听 loopback 并鉴权。数据库和引擎只接受本产品必要的本地访问，凭据不进入 URL、进程命令行参数、命令输出或普通日志。端口由配置或可用端口分配得到，写入受限 locator；端口被占用时重新选择或清楚失败，不能终止未知进程。

进程所有权同时绑定安装身份、DataRoot、可执行路径、PID 和启动时间。stop/update/uninstall 先请求正常退出，无法退出时只处理已验证归属的本产品进程。不能按 node.exe、python.exe、postgres.exe 或 copilot.exe 名字批量结束进程，也不要求关闭用户所有前台 Copilot 会话。

自动启动是当前用户登录任务，默认关闭；用户启用时不申请最高权限，登录后以同一身份启动，便于使用正常 Copilot 登录。系统启动但尚未登录、注销后继续运行，以及机器级 Windows Service 不在首版承诺内。任务创建失败时保留手动 start，不报告已启用。

| 抽象 | 发行包负责 | 替换时保持 |
|---|---|---|
| AgentAdapter | 宿主插件、hooks、MCP 配置、能力诊断；首个是 Copilot | 同一产品 API 和知识库，增加 Agent 不更换模型或引擎 |
| ExtractionModel / 模型 provider | 使用 Copilot 订阅或其他模型方式的私有运行组件 | 认证与模型配置独立于用户工作宿主，不把 Copilot 登录塞进记忆数据 |
| MemoryEngine | Hindsight/Mem0 等适配器、后端组件包、能力与迁移合同 | 产品 API、稳定经验身份、用户纠正/忘记记录 |

组件管理另有内部运行合同：prepare 校验并准备组件，start 返回组件实例身份和端点，health 区分进程存活/数据可读/可写/模型可用，quiesce 排空或隔离写入，stop 只终止已核对归属的进程，backup/migrate/restore 由对应后端实现。它与 MemoryEngine 的 ingest/retrieve 等知识操作分开，不能假定更换 SDK 就已经支持新后端的安装和恢复。

宿主插件使用 InstallRoot/bin 下的稳定入口，并进行协议握手，不把版本目录硬编码到用户配置。已运行的旧 MCP 进程不会因为 active.json 改变自动换代码；协议不兼容时停止旧路径，提示重载插件或新开会话，不承诺热切换。

核心停机时 MCP 返回 unavailable，不各自新建数据库或后台实例。模型 SDK 内部用于推理的 Copilot runtime 与用户工作会话隔离，避免递归采集自身提取；这两种 Copilot 用途分别诊断。

## 安装与激活顺序

1. 获取当前用户安装锁，检查平台、目录权限、磁盘空间、已有安装身份和配置。相同版本重复安装走检查/修复，不重置数据。
2. 下载该版清单与组件到 staging，检查版本、大小和摘要；失败保留旧程序可用，输出可重试原因。
3. 解包后直接按绝对路径运行新 CLI 的基本自检，验证所有 runtime 可加载、本地模型可读取，不切 PATH/active。
4. 首次安装初始化数据目录与受限凭据；升级按下一节先排空旧作业并完成一致备份。只允许一个实例打开同一数据目录进行迁移。
5. 使用明确的候选版本启动组件，完成数据库、引擎、认证 API 和 UI 资源检查。结构化模型探测单列；登录缺失不会被数据库健康掩盖。
6. 原子更新 active.json，再提交稳定 launcher 和用户 PATH。若后一步失败，按数据兼容性恢复旧激活记录或进入可修复状态，不能一边失败一边报告成功。
7. 安装/更新用户选择的 AgentAdapter，保存只属于本产品的注册记录，运行分项 doctor，输出已完成与待处理状态。插件失败时已安装核心可保留，但明确“代理未接入”，重试不得创建重复注册。

安装默认启动一次后台服务；是否登录自启按用户设置。非交互模式下不弹出登录窗口、不无限等待、不接受新的使用条款，返回可机器解析的缺项。拟定安装结果至少区分 ready、installed_needs_setup 和 failed，分别使用退出码 0、2、1；这里只约定安装器，质量评测沿用其自身退出码合同。

## 升级、回滚与卸载

更新由用户执行固定版本 update 或同版发布安装器触发。首版不静默升级，后台不自动替换模型或记忆引擎。组件由产品清单统一锁定，不分别追踪上游 latest。

下载与基本自检在旧服务仍可运行时完成。真正切换前暂停 Connector 新拉取与新写入，排空或持久化未完成作业，确认旧写请求终止；仍有 unknown 操作时阻止迁移。备份包括领域控制、经验、来源撤回/永久忘记、引擎状态与必要配置，不只复制数据库中的向量记录。数据库备份必须采用已验证的一致方式，不能在活跃写入时直接复制数据库目录。

新 schema 在维护状态中迁移并验证，尚未开放新写时可以按已核实快照回退。新版本一旦接受新材料、纠正或删除，代码回退不能无条件恢复旧数据库；必须检查旧程序可读的 schema 与适配协议，并保留后来产生的用户控制记录。不兼容时进入修复/向前迁移，不能通过丢弃新数据或复活已删经验换取“回滚成功”。数据库主版本升级与 MemoryEngine 产品更换属于显式迁移，不混进普通补丁更新。

Windows 文件占用通过保留旧版本目录解决。升级不原地覆盖仍被加载的 runtime；安全清理旧版本时检查进程引用和组件引用。升级后的插件需要宿主重载时给出说明，前台 Agent 仍可继续不依赖旧记忆的正常工作。

普通 uninstall 先持有安装与 DataRoot 维护锁，关闭本产品登录自启和新输入，核对并停止本产品组件，再删除本产品插件注册、稳定 launcher、PATH 项和无其他版本引用的 runtime；保留 DataRoot，说明其位置与大小。无法删除锁定文件时列出残留，不谎报清理完成。固定版本 bootstrap 须提供经同版清单校验的卸载/清理维护入口，launcher 已删除后仍可重试；维护入口不启动采集或数据库。用户改过的宿主配置只移除已登记属于本产品的部分，不能恢复旧整文件而覆盖其他插件变更。

永久清理单独进行，显示将清理的数据目录和本产品管理备份，经用户明确确认后执行。先持有安装与 DataRoot 排他维护锁，关闭自启与新输入，终止或隔离待处理任务，确认核心、引擎、数据库和模型 helper 均不再持有目标目录，再清理；不能一边后台写入一边删除。未知进程或文件占用无法排除时停止并保留待清理状态。通常在卸载程序前运行 data purge；程序已经卸载时，通过同版 bootstrap 的维护入口执行，不启动正常服务。成功后清理本安装登记拥有的凭据；不得删除共享 Copilot/gh 登录、其他系统凭据、用户工作目录、其他 PostgreSQL 数据或用户自己导出的文件。清理模型缓存与清理经验也是两项可区分操作。

## 构建与发布流程

CI 在目标 Windows 平台构建代码、整理私有 runtime、后端与模型清单；采用依赖锁和固定上游版本。原生扩展编译、wheel 解析和许可核对发生在构建阶段。打包步骤不得把开发者登录、私有资料、开发缓存和测试 profile 带入发行包。

先构建版本组件，生成含组件摘要的 release manifest，再生成内嵌 manifest 摘要的 install.ps1；manifest 不包含自身或 bootstrap 的摘要，避免循环依赖。创建 draft release 并上传全部产物，再对同一批产物运行干净机器安装、升级和卸载验收。draft 资产的测试认证由 CI 注入，不进入公开脚本；公开安装入口另在 release 对外可达时验证。发布安装器前必须保证它引用的所有资产已存在且摘要一致；公开发布只能使用通过验收的那批字节，重建后必须重新校验。

首版重点验证 Windows x64、无管理员、无预装 Node/Python/数据库/Docker。再覆盖已装 Copilot 与未装/未登录宿主，分别确认可用与待配置状态。网络/磁盘/文件锁等故障用安装场景测试；真实模型和自动回填仍需真实 Copilot 账号与固定宿主版本验证，不能由 mock 替代。

安装验收 ID 和必测结果统一维护在[实施与验收](05-delivery-and-validation.md#发布与安装验收)，评估记录方式沿用[实现质量评估](09-quality-evaluation.md)。一次安装成功不能代替经验质量和用户收益验收。

## 落实顺序与当前限制

先完成一个 Hindsight 原生 Windows 发行切片：固定 runtime、私有 PostgreSQL 与多语言模型，使用现有 Copilot 登录执行一次提取和召回，并验证关闭终端后仍可用。这个切片决定默认发行配置是否成立。

随后实现版本目录、稳定 launcher、安装锁、组件清单与分项 doctor，再接入安装/升级/卸载、Copilot 插件和故障恢复。正式发布前通过 P0–P3 产品验收与本安装 profile。

当前交付物是设计文档。安装器、发行组件包、后台管理器和正式下载地址尚未交付，安装、升级、回滚与卸载验收尚未执行。上游能力依据见[Hindsight 安装说明](https://hindsight.vectorize.io/developer/installation)和[Copilot provider](https://hindsight.vectorize.io/developer/models#github-copilot-setup)；发布支持范围以 LessonLoop 实际发行包的验收结果为准。
