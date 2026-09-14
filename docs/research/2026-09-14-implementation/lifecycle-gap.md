# 来源清理实现前置记录

当前开发分支的来源屏障尚未公开为用户 API。物理清理实现必须先完成受控副本清单，不能把来源暂停回执写成清净回执。

固定 Hindsight 0.9.2 的 deleteDocument 不能独立证明单来源内容已全部擦除：observation_history 存在孤立历史，llm_requests 没有来源级删除 API。clearObservations 影响整个 bank；整 bank 删除又会删除同 scope 其他来源。采用单源删除前，必须明确处理这些副本，缺少精确能力时保持 pending。

首版需要把 SourceBinding、EngineBinding、WriteOperation 和 copy manifest 一起接入；每份 Material 的 segment、产品证据、方法及历史、原生文档、Mental Model、operation payload 和 trace 分别有归属与确认。一个 Material 的单 segment 撤回不能删除其他 segment 后继续宣称其支持有效。

下一步按固定官方 API 验证可精确清理的文档/模型/作业，剩余历史与 trace 采用受控维护或有限学习命名空间，并记录实际新增的必要适配。相关操作未验证前不开放擦除/忘记入口。
