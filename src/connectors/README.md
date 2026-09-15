# 样例连接器

`input.ts` 规范化material、work_case、experience_draft、method_draft；`sample-source.ts`读取文件并形成有限页。完整来源最多8片，每片32KiB、每批256KiB，UTF-8原文不截断。显式parts必须附完整唯一partKeys和complete=true。片段共用来源族，全部接收与旧来源替代在同一事务；学习状态汇总全部片，重试仅处理失败片。

sample.ts 读取用户明确选择的 JSON 变更文件。连接默认暂停；用户查看初始范围后恢复并同步。接收、来源替代、绑定和游标在同一事务提交，学习状态单独记录。

已接入用户 RPC：connector.add/list/state/sync/schedule/bindings/forget/retry。state 支持 active、paused、removed。snapshot 更新资源；append 使用独立事件键；correct 必须指定绑定和来源修订；withdraw/erase 可以立即关闭在途来源。父忘记沿文件父图和持久排除标记拒收后代。

PostgreSQL 回归覆盖接收事务中断、重复同步、版本标记变化、定向纠正、父忘记、失败重试、稳定来源族和暂停/移除。已补默认关闭的自动同步间隔、持久调度代次和离线合并；稳定分片和案例/经验草稿/方法草稿规范化已实现，完整K01–K13验收进度见[实现计划](../../docs/13-implementation-plan.md)。首版从当前格式初始化，旧开发布局迁移不在范围内。
