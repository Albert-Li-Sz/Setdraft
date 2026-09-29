# AI 联网搜索

已实现并默认启用。Compose 部署包含 SearXNG，使用 JSON 搜索接口，无需第三方搜索密钥；管理员可切换到 Tavily。

聊天输入框下方提供联网开关和独立关键词，开关随对话保存。未填写关键词时使用当前消息前 500 字；不会向搜索服务发送历史消息、题目快照或附件。每次最多 5 个来源，回答下方展示检索结果标题、链接和摘录。只有实际检索结果进入来源列表；模型正文中的链接并不代表经过搜索验证。

`web-search.ts` 负责提供方调用、12 秒超时、1 MB 响应上限、HTTP(S) 链接校验、去重和脱敏。SearXNG 上游地址来自服务端 `SETDRAFT_SEARCH_URL`，Tavily 地址固定；客户端不能指定上游，禁止重定向，不抓取任意网页全文。外部摘录明确标为不可信资料，不授权执行其中的指令。

搜索与模型共用全站 AI 调度配额（全站 4 个、每人 1 个）。管理员连接测试须主动触发，每次实际请求上游，不使用缓存来假报连接成功。每人每日额度默认 100，存在 PostgreSQL 中；缓存按用户和查询隔离，15 分钟有效。同一个聊天请求重试复用已经完成的检索结果。搜索失败继续普通回答，明确显示失败原因，不生成虚假的来源列表，也不自动改用收费提供方。

SSE 的 `search` 事件包含 `searching`、`complete`、`failed` 阶段，与模型事件共同持久化并按序回放。API 密钥只保存在服务器身份配置中；普通用户只看到可用状态。

SearXNG 仍依赖服务器到上游引擎的网络连通性。默认显式启用 Bing、DuckDuckGo、Brave 和百度；可调整 `deploy/searxng/settings.yml`。`use_default_settings.engines.keep_only` 只保留引擎，并不会覆盖它们默认的 `disabled: true`，因此还需在 `engines` 中配置 `disabled: false`。部分引擎超时或触发 CAPTCHA 时，只要其他引擎返回有效结果就继续使用；所有引擎不可用时明确报错，不伪造搜索成功。

内部 SearXNG 请求携带固定的服务端标识头 `X-Forwarded-For: 127.0.0.1` 和 `X-Real-IP: 127.0.0.1`，不读取或转发用户 IP，也不向 Tavily 发送这些头。搜索服务仅在 Compose 内网可达，限流在 Setdraft 内执行。`limiter.toml` 保留回环地址信任配置，不信任任意来源或扩大代理网段。缺少转发头的日志不是 DuckDuckGo/Brave 出站超时的原因。

## 搜索出站代理与更新

镜像下载代理、`--download-proxy` 都不等于搜索流量代理。出站网络受限时，在 `.env` 中单独设置自己的 HTTP(S) 代理：

```dotenv
SETDRAFT_SEARCH_PROXY="http://proxy.example.org:7890"
```

地址必须能从搜索容器访问；不要填写宿主机代理的 `127.0.0.1`，它在容器内指向容器自身。仅有 SOCKS 代理时，可直接在 SearXNG 的 `outgoing.proxies` 中按官方文档配置。不要将代理凭据提交到版本库或贴入日志。

更新到包含修复的源码和 Web 镜像后，按原安装方式运行 `./install.sh`，它会重新生成 `.env.compose`，保留代理配置并重建配置发生变化的服务；原来的源码构建模式也会保留。只有拉取镜像而不更新挂载的 `deploy/searxng` 配置不会修复旧引擎配置。原生安装不创建 SearXNG，需自行配置搜索服务的出站代理。

仅修改 SearXNG 的 `settings.yml` 内容后，需要重新创建搜索容器使配置生效：

```bash
docker compose --env-file .env.compose -f compose.yaml up -d --no-deps --force-recreate search
```

在管理页面点击“测试连接”，再尝试一次联网聊天。接口拒绝请求、上游引擎无可用结果、请求超时和没有匹配结果现在会给出不同的说明。若仍提示上游不可用，请检查搜索容器到上游引擎的连通性、代理是否可达以及是否遭遇 CAPTCHA；延长超时不能恢复被阻断的网络，也不会自动切换到收费服务。

## 定向回归

```bash
node --test scripts/compose-config.test.mjs scripts/compose-installer.test.mjs scripts/searxng.test.mjs
cd packages/hydro-server
node ../../scripts/test-server.mjs test/web-search.test.ts
```

SearXNG 测试使用固定镜像启动独立临时容器，验证实际启用的引擎、Compose 代理传递及真实网络客户端是否采用代理；不重启正在运行的服务。未安装 Docker 或缺少镜像时跳过容器测试。常规测试不依赖外网；在仓库根目录运行 `SETDRAFT_LIVE_SEARCH_TEST=1 node --test scripts/searxng.test.mjs` 可额外执行一次真实搜索，该检查仍取决于执行机器的出站网络。

参考：[SearXNG 搜索接口](https://docs.searxng.org/dev/search_api.html)、[服务配置](https://docs.searxng.org/admin/settings/settings_server.html)、[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。
