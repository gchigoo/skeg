# Veritack 非目标

没有足够理由进入内核的能力，留在扩展里。以下明确不做：

- 不内置 subagent 编排
- 不内置 plan mode
- 不维护自然语言超级 Router
- 不默认创建任务 artifact
- 不为 feature、issue、refactor 建立不同状态机
- 不在首版支持所有 Coding Agent（首版只适配 Pi）
- 不建立知识图谱
- 不建立 Web 管理后台
- 不提供复杂 Pack DSL（至少出现 3 个真实 Pack 且共享同一模式后再抽象）
- 不维护大量兼容别名
- 扩展可以增加 Policy / Check / Record（`config.providers`）；扩展不能增加新的核心阶段状态机
