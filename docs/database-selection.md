# 数据库基础选型

状态：完成选型与迁移设计；当前版本仍运行 SQLite WAL，尚未实施 PostgreSQL 迁移。

面向后续多人高并发、独立 worker 和多实例部署，选择 **PostgreSQL 18** 作为目标关系数据库。当前 Docker Compose 保留已在运行的 SQLite 数据，避免只增加一个无人使用的 PostgreSQL 容器，或把同步 SQLite 调用伪装成支持 PostgreSQL 的抽象。

## 依据与取舍

SQLite 适合同机应用服务器、嵌入式存储；单数据库文件同时只能有一个写入者。现有每用户工作区分库降低了争用，适合目前单进程小团队部署。扩大到多个应用实例或大量并发写入时，客户端/服务器数据库更合适。[SQLite 官方适用范围](https://www.sqlite.org/whentouse.html)

PostgreSQL 的事务、约束及行级安全适合将用户工作区整合到共享数据库。启用 RLS 后可以对行设置读写策略，但表所有者和 BYPASSRLS 等特权角色可以绕过；运行应用必须使用受限角色，迁移角色单独保存。[PostgreSQL 行级安全](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)

这些是基于当前代码和扩展方向的选择，不代表仅更换数据库就能支持多实例；任务抢占、文件存储和全站调度也需要同步改造。

| 方案 | 本项目结论 |
| --- | --- |
| SQLite WAL + 独立个人库 | 当前默认，迁移前保留；本地磁盘、单 API 进程 |
| PostgreSQL 18 | 后续团队部署目标，支持统一事务、查询与行级隔离 |
| MySQL / MariaDB | 可行，但无须为同一产品维护第二套服务器数据库实现 |
| MongoDB / Redis | 不作为题目、身份与发布历史的主数据库；当前业务依赖事务和关系约束 |

## 模块与模型

不把 `DatabaseSync.prepare()` 原样套一层接口。按完整业务事务设计异步存储入口：IdentityRepository、ProjectRepository、ReleaseRepository、ContestRepository、JobRepository、ChatRepository；例如 `saveProject(expectedRevision, changes)` 在一次事务中比较版本、保存文档及文件引用，冲突返回原有 409 语义。

身份和业务表分别放入 identity/workspace schema。业务表包含不可空 owner_id；项目、版本、竞赛、任务与聊天的外键包含 owner_id，防止跨用户关联。用结构化列保存赛制、标题、状态、创建时间和 revision，可变题面配置放 JSONB；列表检索由索引支持，避免逐个反序列化整个文档。团队管理员权限仅管理身份和配置，不赋予跨用户读取内容的数据库策略。

用户身份来自已验证会话，在事务内使用 `SET LOCAL` 设置上下文；连接归还池前事务结束，不能依赖长连接残留的用户变量。启用并强制 RLS，应用角色无所有权、无 BYPASSRLS。文件继续使用内容哈希，先写临时文件，事务提交引用，再完成原子落盘；失败残留由回收器处理。多机部署另迁移到对象存储，不能将 SQLite 或本地 blobs 直接放 NFS 作为扩展方案。

任务使用数据库事务抢占和有期限的租约，明确 heartbeat、超时、幂等结果提交。全站 2 个沙箱/4 个 AI、每用户 1 个的限制必须移到跨实例协调层；不能继续依赖 Node 内存队列。SSE 仍从持久化事件序号续接，通知只用于唤醒。

## 迁移与验收

1. 先建立异步事务边界，保留当前 SQLite 实现的契约测试；不同时改 UI 协议。
2. 新建 PostgreSQL schema、索引、RLS、版本迁移与测试专用实例；A/B 身份隔离、同名文件、下载和聊天全部验证。
3. 停止写入，完整备份身份库、所有个人库和 blobs；离线导入固定用户绑定、原 ID、revision、时间与文件哈希。迁移工具记录版本和检查点，允许重复运行；导入后清空会话和一次性安装码。
4. 比较每用户各实体数量、引用关系、发布包 SHA-256，抽查历史包下载/恢复；做并发冲突、进程中断和队列恢复试验。通过后切换配置，原目录只读保留。
5. 初次切换失败时回到原 SQLite 快照；PostgreSQL 已产生新写入后不能直接切回旧快照，须维护窗口导出增量或恢复经确认的备份。

PostgreSQL 使用 pg_dump/pg_restore 做逻辑备份，同时备份文件对象和部署配置；数据库备份自身不包含题目 ZIP/PDF 等外部文件。[官方备份说明](https://www.postgresql.org/docs/18/backup-dump.html)

实际迁移的完成标准：跨用户隔离、CAS、任务租约、断电恢复、旧包哈希和恢复演练全部通过，再启用 PostgreSQL Compose 服务。当前 Compose 使用文件锁确保一个数据目录只有一个容器服务，维护工具离线验证全部 SQLite 和文件哈希，作为迁移前可交付的部署基础。
