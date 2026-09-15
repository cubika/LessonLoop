# 外部资料与工作记录接入

日期：2026-09-15。状态：当前Connector合同，样例接入与生命周期已有实现，剩余差距见[13](13-implementation-plan.md)。具体邮件、笔记、目录和工单连接按需交付，不因定义接口就宣称已支持来源。

## 职责

Connector负责外部认证、读取、分页、来源身份和内容转换。ConnectorRuntime负责连接配置、调度、背压、可靠接收与游标。核心将获准输入整理为WorkCase或提炼Experience，再形成Playbook。Connector不直写引擎，不授予active/supported，不替用户运行方法。

同一Connector可有多个Connection，各自绑定账号、选择范围和目标scope。凭据在系统凭据设施，模块只保存引用。首期随产品交付显式注册的模块，无插件市场、热加载或公网Webhook要求。

## 连接配置

Connection包含connectionId、connectorType/version、targetScopeId、sourceSelection、initialRange、mode、schedule、deletionPolicy、credentialsRef和transformRevision。mode为scheduled_pull或authenticated_push，远端通知只能经受认证的本地接收链路或拉取到达。

首次配置明确初始回填范围，不默认导入所有历史。active/paused/needs_auth/error是连接状态，接收进度与学习作业状态分别显示。暂停或移除停止新读取，已接收学习默认继续，方法和已有知识保留；取消、撤回或删除是单独动作。

## 输入与标准操作

| 输入 | 核心处理 |
|---|---|
| source | 保留原文和归属；也可提交目标、尝试、结果和缺口，由核心整理内部工作视图 |
| experience_draft | 校验单一主张、原文和边界，再准入 |
| playbook_draft | 拆出步骤中的事实依据，检查条件、分支和完成标准，再组装方法 |
| source_delete | 按连接声明和用户配置撤回或擦除来源，不直接删除所有共享知识 |

标准调用为checkConnection、readPage(checkpoint,limits)、normalize、ingestChanges(connectionId,batch)。返回每项accepted/unchanged/ignored/rejected/retryable，接收成功不表示学会。外部ID、发布状态和用户角色不会直接成为内部受信字段。

普通资料不必伪装成一次工作；外部方法文档不等于已在用户环境验证的方法。转换保留来源角色、原文、时间及位置，模型不补造身份。容量统一见[07](07-storage-model.md#预算)。

## 来源变化模型

SourceChange包含sourceKey、changeType、mutation、sourceVersion?、sourceUpdatedAt?、locator?及规范化输入。sourceVersion只用于相等判断，除非提供方明确保证顺序；服务为接受的新内容生成sourceRevision。

| mutation | 来源身份与处理 |
|---|---|
| snapshot | 稳定资源的新完整快照。片段全部可靠接收后，旧修订支持失效，新修订重新提炼 |
| append | 每个事件映射独立稳定sourceKey，parentSourceKey指向任务。新增结果不撤销先前动作 |
| correct | 明确同连接correctsRef={bindingId,sourceRevision}，只替换对应旧事件，其他观察保留 |

同事件键同内容重放为unchanged；无明确纠正语义的同键不同内容报冲突。不同作者对同事件的描述保留不同来源，不自动互相覆盖。没有稳定事件身份的来源只声明snapshot，不猜append。

外部账号、资源身份、目标scope变化时建立新连接或明确迁移，不能复用旧绑定。转换和筛选语义变化递增transformRevision，调度或凭据轮换不改变内容身份。

## 分片与可靠接收

snapshot带完整partKey清单和complete=true；超出单块预算时分成有限稳定片段，仍超限则建立稳定子资源或报告需缩小范围。append/correct每事件使用独立资源，其作业仍按bindingId、sourceRevision、partKey确定身份。

1. 核对连接、scope、来源身份、大小和脱敏，判定重复或新修订。
2. 保存SourceBinding.pending与稳定学习作业引用；全部片段接收确认前不替代旧支持。
3. snapshot/correct确认替代目标与失效屏障，append只接受新事件；可靠接收或持久终结处置后才能推进游标。
4. 学习异步执行，原生operation与产品作业分别恢复；结果全部有明确处置后更新current，不把部分失败显示为已完成学习。
5. 未确认操作保留pending，后来的变化背压或等待重新读取，不能覆盖在途输入。

current/pending是每个资源的有限状态，不是整任务的事件数组。事件绑定与来源控制在有引用或可重放时保留；正文按07到期清理。清理去重元信息前必须确认没有旧作业、重放或依赖，不能仅凭材料到期删除接收依据。

## 调度与失败

同连接一次运行，重复触发合并。恢复后从已确认游标追赶，不补发每个错过的定时运行。时间窗口来源使用重叠读取和稳定键去重；没有增量协议时在用户选定范围内比较完整快照。

网络失败、限流、登录失效和部分页面不会推进未确认游标。不同连接按预算轮换，单一高频来源不能占满学习队列。错误与未知结果分开，重试沿用原身份，不以语义搜索判断是否曾写入。

滚动窗口缺项、临时404或读取失败不证明来源删除。确认撤权后停止相关来源的自动使用；可见的历史仍按权限和保留政策展示。来源无法检测删除时明确标能力缺失，不能承诺自动撤回。

## 更新、撤回与忘记

source_superseded表示一个旧修订被替代，source_withdrawn表示来源不再支持建议，source_erased表示清除副本，user_forget表示明确永久拒收。状态、引用和所有工作Agent输出均检查当前来源控制。

删除一个来源时按剩余独立支持重评Experience与Playbook，不无差别清空知识。用户纠正独立保存，普通重复同步不覆盖持续要求、不启用disabled、不延长复评期限。

忘记整任务或源对象时，父资源标excluded，完整清点子资源及保留的旧修订标记并拒收未来追加。无法列出子资源的Connector不能声明支持完整父对象忘记；需先补清单能力或仅提供明确有限范围删除。

Connector卸载保留来源绑定与用户控制，只移除接入；删除数据使用核心操作。外部系统原件与用户另存导出不在本服务远程删除范围。

## 管理与验收

UI/CLI提供添加、检查、首次范围预览、立即同步、暂停/恢复、重新认证、重试和移除，展示读取、可靠接收和学习三种进度。协议差异留在Connector，产品对象和核心规则不随来源改变。

| ID | 必须验证 |
|---|---|
| K01 | 不同来源实现同一合同，无需改变产品对象语义 |
| K02 | 首轮回填、重叠窗口和重复页不重复支持 |
| K03 | 部分接收失败或回执丢失不跳游标，重试沿原身份 |
| K04 | 接收后学习失败或重启可恢复，不显示已学会 |
| K05 | 快照变更和旧内容回归创建正确新修订，不误用永久忘记 |
| K06 | 同文字不同来源保留归属，删除一个按剩余支持重评 |
| K07 | 权威删除、撤权和临时不可用分别处理 |
| K08 | 乱序推送和不透明版本按声明能力重取或比较 |
| K09 | 用户纠正/忘记后重放不能覆盖或恢复旧对象 |
| K10 | 限流和高频来源下接收正确且其他连接能推进 |
| K11 | 暂停/移除不停止核心和Agent，已有方法按状态保留 |
| K12 | 超限、分片不完整和pending冲突有明确结果，不截断 |
| K13 | 追加不撤销先前动作，定向纠正只影响目标，父忘记拒收后续子事件 |

P3交付一个可复现样例Connector，真实来源在P4逐项交付；相同测试在实际来源的能力范围内执行。
