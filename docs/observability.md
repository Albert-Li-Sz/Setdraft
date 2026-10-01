# Setdraft OpenTelemetry

遥测默认关闭。SDK 和 OTLP exporter 仅位于服务端；浏览器和 `pi-telemetry` 继续使用中立接口。无需新增数据库表，也无需部署监控栈才能运行业务。

## 启用 OTLP HTTP/protobuf

在部署 `.env` 中配置，然后按原有方式重启服务。原生安装脚本和 Compose 都会保留这些字段；Compose 的 collector 地址必须能从 web 容器访问，`localhost` 指向 web 容器自身。

```dotenv
SETDRAFT_OTEL_ENABLED="1"
OTEL_SERVICE_NAME="setdraft"
OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
OTEL_EXPORTER_OTLP_ENDPOINT="https://collector.example.com/otlp"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20replace-with-token"
OTEL_TRACES_SAMPLER="parentbased_traceidratio"
OTEL_TRACES_SAMPLER_ARG="0.1"
```

共同 endpoint 会追加 `/v1/traces` 和 `/v1/metrics`。也可以分别指定以下字段；各信号的 endpoint 是完整 URL，不再追加路径。认证 headers 使用逗号分隔的 `key=value`，值使用 URL 编码。

| 配置 | 默认行为 |
| --- | --- |
| `SETDRAFT_OTEL_ENABLED` | `0`；设置 `1` 启用 |
| `OTEL_SERVICE_NAME` | `setdraft` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | 空 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | 仅支持 `http/protobuf` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `METRICS_ENDPOINT` | 未指定时使用共同 endpoint |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `METRICS_HEADERS` | 合并共同 headers，同名覆盖 |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` / `METRICS_PROTOCOL` | 仅支持 `http/protobuf` |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` |
| `OTEL_TRACES_SAMPLER_ARG` | `0.1`；范围 0–1；测试使用 `1` |

采样器还支持 `always_on`、`always_off`、`traceidratio`、`parentbased_always_on` 和 `parentbased_always_off`。父级采样决定优先，默认仅对根 trace 按 10% 采样。配置无效时只输出固定警告并停用遥测，不输出配置内容。endpoint 不允许 URL 凭据、查询或片段。

## 埋点和数据边界

HTTP span 在响应完成或连接关闭时结束；静态资源、`/api/health` 和 `/api/system/status` 不记录 trace。SSE 记录为 `http.sse`。任务提交时把 W3C `traceparent` 和可选 `tracestate` 存入既有 JSON，执行或恢复时重新关联；不传播 baggage。排队期间没有活跃 span，执行时记录等待时间。重试关联本次提交，旧记录缺少传播字段仍可执行。

手动 span 覆盖任务、AI 客户端调用、搜索、沙箱生成/验证、发布格式导出、竞赛导出和 PDF 编译。PDF 耗时包含父进程观察到的完整子进程生命周期。取消、超时、服务恢复和容器清理单独标识结果。业务任务状态保持兼容；校验报告失败时遥测结果为 `validation_failed`。

| 指标 | 内容 / 单位 |
| --- | --- |
| `setdraft.http.requests` / `http.duration` | API 次数 / 秒 |
| `setdraft.queue.depth` / `queue.running` | 排队数 / 执行数 |
| `setdraft.queue.wait` | 排队耗时，秒 |
| `setdraft.task.duration` / `task.results` | 执行耗时 / 结果次数 |
| `setdraft.pdf.duration` | 完整 PDF 编译耗时，秒 |
| `setdraft.ai.duration` / `ai.first_token` | AI 总耗时 / 首 token 延迟，秒 |
| `setdraft.ai.tokens` | 输入、输出、缓存读取和写入 token |
| `setdraft.search.duration` | 搜索耗时，秒 |

指标标签只包含路由模板、方法、状态、任务类别、协议、队列类别和结果。请求、任务及聊天请求 ID 仅进入 span 和关联 stdout 日志。属性使用白名单，排除 Cookie、密钥、题面、代码、聊天内容、搜索词和原始 SQL；异常不导出原始消息或堆栈。第一版不使用 OTel logs exporter。

exporter 故障不会阻塞业务。trace 使用最多 2048 条队列、每批 256 条、单并发、有界超时；metrics 默认每 60 秒导出。关闭最多等待 5 秒。设置 `SETDRAFT_OTEL_ENABLED=0` 后 SDK 不创建 exporter，也不发出遥测请求。

## 服务端注入与验证

`@setdraft/server` 导出 `Observability`、`createObservability` 和 `NOOP_OBSERVABILITY`。创建 `ManualProjectStore`、`ChatService` 和 HTTP server 时注入同一个实例；CLI 已完成注入。实例采用独立异步上下文，不注册全局 tracer provider。

```sh
cd packages/hydro-server
node ../../scripts/test-server.mjs test/observability.test.ts
```

测试使用内存 exporter 和本地 HTTP/protobuf 接收器，覆盖传播、并发隔离、持久化重试、取消、低基数指标、脱敏、关闭和 exporter 故障。参考 [OpenTelemetry 官方 exporter 文档](https://opentelemetry.io/docs/languages/js/exporters/)。
