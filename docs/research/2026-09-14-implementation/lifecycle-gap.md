> 历史前置记录。2026-09-15 已补登记 bank 清理、投影写入/删除共锁及来源 API，并完成新布局原生验证；最新状态见 [运行记录](README.md#2026-09-15-发布准备进展)。下文保留实现前的约束和发现，旧共享布局迁移仍未完成。

# 来源清理实现前置记录

当前开发分支的来源屏障尚未公开为用户 API。物理清理实现必须先完成受控副本清单，不能把来源暂停回执写成清净回执。

固定 Hindsight 0.9.2 的当前正常删除路径会显式删除受影响 observation 的 history；早期迁移注释提到孤立历史，不能据此声称当前全部删除路径都遗漏历史。仍需核对历史前代脱离当前依赖的内容和 llm_requests：后者没有来源级删除 API。clearObservations 影响整个 bank；整 bank 删除会删除同 scope 其他来源。采用单源删除前，必须清点实际副本，缺少精确能力时保持 pending。

首版需要把 SourceBinding、EngineBinding、WriteOperation 和 copy manifest 一起接入；每份 Material 的 segment、产品证据、方法及历史、原生文档、Mental Model、operation payload 和 trace 分别有归属与确认。一个 Material 的单 segment 撤回不能删除其他 segment 后继续宣称其支持有效。

下一步按固定官方 API 验证可精确清理的文档/模型/作业，剩余历史与 trace 采用受控维护或有限学习命名空间，并记录实际新增的必要适配。相关操作未验证前不开放擦除/忘记入口。

新增 hindsight_maintenance.py 目前仅提供 plan-residuals，只读核对显式行 ID 的 bank 归属和数量，不执行删除，不表示完整来源覆盖。清理执行仍需服务端持久清单、世代核对和迟到写入屏障。

新材料已改用单 LearningJob 的原生 bank，长期短证据按来源划分 bank 并经 chunks 保存；真实案例仍产出 1 个方法。bank 归属在调用前登记，比较方法的来源闭包也保存。其依据是共享 scope bank 无法用整 bank 清理保留其他原材料；新布局仍复用官方提取与索引。旧作业显式保留原布局，不能假定迁移后旧副本已清除。跨案例归纳、原生 delta 和完整清理仍须验收。
