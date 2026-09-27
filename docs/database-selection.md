# PostgreSQL 数据存储

已实施 PostgreSQL 18，作为唯一关系数据库。此版本按全新部署处理，不导入或保留旧 SQLite 业务数据；安装器本身不会擅自删除已有目录。

`identity` schema 保存账号、会话摘要、安装状态、审计、登录限流、团队配置和搜索额度。`workspace` schema 保存 JSONB 文档、文件引用、任务和聊天请求及其事件；所有业务表的主键包含 `account_id`，事件外键也包含同一用户 ID。JSONB 赛制索引为后续服务器端筛选提供基础。

Web 使用无超级用户权限、无 BYPASSRLS 的 `setdraft_app` 角色；启动时校验角色。业务表启用并强制 RLS，用户上下文仅在事务内通过 `set_config(..., true)` 设置，连接归还前完成提交或回滚。服务器验证会话后选择工作区，浏览器不能改变源工作区身份。迁移及备份容器单独持有维护凭据。

`PostgresScope` 提供真正异步的连接池和事务，嵌套事务使用保存点。文档更新通过版本比较实现 CAS；数据库冲突沿用 HTTP 409。文件先复制到临时目录并计算哈希，再在短事务中原子发布不可变文件和引用；回滚时未引用文件可由 GC 清理。GC 和文件发布共享用户级事务锁。

部署保持单 Web 进程和本地文件存储。PostgreSQL 会话 advisory lock 阻止其他 Web 或维护进程同时接管同一数据库；失去数据库租约时停止服务。内存调度限制全站 2 个沙箱、4 个 AI、每用户各 1 个。重启恢复排队任务，已中断执行标为可重试。更换数据库不代表已支持多 Web 实例或独立 worker；这些需要额外的分布式调度及共享对象存储。

Compose 初始化顺序是 PostgreSQL 健康检查 → 一次性 schema 迁移 → Web。数据库和搜索服务不发布宿主机端口。PostgreSQL 使用持久卷，所有用户文件在单独的宿主机目录。

备份维护先停止 Web 并取得相同服务锁，使用 PostgreSQL 18 的 `pg_dump` / `pg_restore`，同时复制用户文件并验证 SHA-256 清单。恢复前先保存当前完整备份；失败时恢复该备份，成功后撤销旧会话。数据库转储不包含外部文件，不能仅备份数据库卷。

参考：[PostgreSQL RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)、[事务客户端](https://node-postgres.com/features/transactions)、[逻辑备份](https://www.postgresql.org/docs/18/backup-dump.html)。
