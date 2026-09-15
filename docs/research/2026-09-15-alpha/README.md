# Alpha 发行验证记录

目标版本：0.1.0-alpha.1，Windows x64，GitHub prerelease。正式releaseReady保持false；alphaReady只表示本页列出的预览检查，完整P0–P3退出条件不继承为通过。

## 官方复用与精简

Hindsight适配删除6个全仓无调用的预留方法，重复POST改用已有productCall，净减少87行；保留实际使用的官方SDK、原生作业、索引和模型provider。Copilot reader/envelope继续使用固定官方0.4.2的有界适配：上游bundle未导出这些小模块，整包hook直接读写原生bank，不能替代产品发布检查。

官方delta刷新适用于固定source_query和持久模型。当前作业查询包含冻结材料与旧方法，直接设置delta会失效；持续模型切换涉及来源/恢复合同，本alpha不另建seed框架，也不宣称已完成这项重构。

## 打包

从白名单重新组包，未直接压缩带staging/versions/active.json的开发目录。使用完整CPython底座，去掉venv路径文件、旧console入口、测试缓存、未使用的Claude和pg0内置二进制；Node只安装生产依赖。模型与依赖许可随包保留。私有Python在新目录以-I -B导入Hindsight、Copilot、ONNX等关键依赖通过，sys.path未指向开发机其他目录。

候选清单逐文件SHA256及凭据模式扫描通过；扫描只说明所覆盖模式未检出，不替代来源审查。最终发布ZIP另记摘要和字节数，绑定源commit。安装/运行后新产生的数据不回拷发行目录。

## 检查范围

工程检查包括类型检查、构建、65项单元测试、29项PostgreSQL集成测试，以及12项生命周期和5项安装恢复隔离测试。生命周期测试实际执行PowerShell清理fixture，覆盖中文路径、同版恢复、保留用户文件、错误确认、junction拒绝和文件占用重试。

真实字节验收将检查新目录安装、私有服务启动、官方SDK登录诊断、项目范围配置、Copilot注册/移除、页面、停止、自启开关、受控清理和保留数据卸载。Windows干净虚拟机及完整硬件/故障矩阵不在本次alpha声明范围。

使用方式见[alpha说明](../../14-alpha-release.md)。


# Alpha已知边界

本次alpha按固定版本和摘要分发，GitHub Release标记为预发布。正式P0–P3质量门槛保持未通过，完整泛化与收益对照不作为已完成能力宣传。

实际新目录安装发现并修复了三项开发环境没有暴露的问题：PostgreSQL可执行路径也必须使用Windows短路径；组包规则不能排除官方Alembic versions目录；PowerShell 5.1必须显式按UTF-8读取中文安装记录。包检查现验证官方迁移链头和私有Python路径。


## 实际安装与宿主结果

修复后的候选在新中文目录完成安装和空库初始化，私有核心及Hindsight启动通过，独立本地FlashRank加载成功。安装后的真实模型调用完成fixture案例→经验/方法→发布→准备；报告为.local-validation/results/installed-alpha-learning.json。

隔离Copilot home只重建host/login账号选择字段，系统凭据未复制。实际user hooks注册成功；初次PowerShell5.1读取无BOM中文JSON和MCP隐藏子进程隐式stdio导致失败，分别修为显式UTF-8与标准句柄。复测真实view、lessonloop-reassessTask、lessonloop-prepareMethod全部成功；MCP initialize/tools.list在已安装launcher下返回11项工具，stderr为空。

浏览器实际登录、方法库和方法详情读取通过，长英文正常换行，无横向溢出；补了当前导航高亮和登录阶段可见错误提示。自启在独立installationId下enable/disable通过并恢复关闭；受控purge清空测试数据库后setup重建空库通过，卸载保留数据另记录完成结果。

自动审批曾拒绝直接复制loggedInUsers整个对象，原因是可能带会话凭据；随后只检查键名，改为显式重建host/login两个字段并通过审核。本次没有复制或上传认证秘密。
