# 样例连接器

sample.ts 读取用户明确选择的 JSON 变更文件。连接默认暂停；用户查看初始范围后恢复并同步。接收、来源替代、绑定和游标在同一事务提交，学习状态单独记录。

已接入用户 RPC：connector.add/list/state/sync/schedule/bindings/forget/retry。state 支持 active、paused、removed。snapshot 更新资源；append 使用独立事件键；correct 必须指定绑定和来源修订；withdraw/erase 可以立即关闭在途来源。父忘记沿文件父图和持久排除标记拒收后代。

PostgreSQL 回归覆盖接收事务中断、重复同步、版本标记变化、定向纠正、父忘记、失败重试、稳定来源族和暂停/移除。已补默认关闭的自动同步间隔、持久调度代次和离线合并；分片、全部 K01–K13 验收及旧布局迁移仍未完成，不能据此声明 P3 已通过。
