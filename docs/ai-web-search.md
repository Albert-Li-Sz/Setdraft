# AI 联网搜索

已实现并默认启用。Compose 部署包含 SearXNG，使用 JSON 搜索接口，无需第三方搜索密钥；管理员可切换到 Tavily。

聊天输入框下方提供联网开关和独立关键词，开关随对话保存。未填写关键词时使用当前消息前 500 字；不会向搜索服务发送历史消息、题目快照或附件。每次最多 5 个来源，回答下方展示检索结果标题、链接和摘录。只有实际检索结果进入来源列表；模型正文中的链接并不代表经过搜索验证。

`web-search.ts` 负责提供方调用、12 秒超时、1 MB 响应上限、HTTP(S) 链接校验、去重和脱敏。SearXNG 上游地址来自服务端 `SETDRAFT_SEARCH_URL`，Tavily 地址固定；客户端不能指定上游，禁止重定向，不抓取任意网页全文。外部摘录明确标为不可信资料，不授权执行其中的指令。

搜索与模型共用全站 AI 调度配额（全站 4 个、每人 1 个）。管理员连接测试须主动触发。每人每日额度默认 100，存在 PostgreSQL 中；缓存按用户和查询隔离，15 分钟有效。同一个请求重试复用已经完成的检索结果。搜索失败继续普通回答，明确显示失败原因，不生成虚假的来源列表，也不自动改用收费提供方。

SSE 的 `search` 事件包含 `searching`、`complete`、`failed` 阶段，与模型事件共同持久化并按序回放。API 密钥只保存在服务器身份配置中；普通用户只看到可用状态。

SearXNG 仍依赖服务器到上游引擎的网络连通性。默认引擎为 Bing、DuckDuckGo、Brave 和百度；可调整 `deploy/searxng/settings.yml`。镜像下载代理不等于搜索流量代理。生产网络应通过管理员“测试连接”确认，不依赖未知公共搜索实例。

参考：[SearXNG 搜索接口](https://docs.searxng.org/dev/search_api.html)、[服务配置](https://docs.searxng.org/admin/settings/settings_server.html)、[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。
