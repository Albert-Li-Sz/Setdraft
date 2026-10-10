# AI 联网搜索

已实现并默认启用。Compose 部署包含 SearXNG，聚合 Bing、360 与 arXiv 论文，使用 JSON 搜索接口，无需第三方搜索密钥；管理员可切换到 Tavily。

聊天输入框下方提供联网开关和独立关键词，开关随对话保存。未填写关键词时，当前聊天模型结合问题和必要的最近对话生成 1–3 组关键词，处理追问中的指代。手填关键词每行一组，最多 3 组，跳过 AI 规划。搜索服务只接收关键词，不直接接收历史消息、题目快照或附件；涉及未公开题目时应关闭搜索或手填公开关键词。

最多同时搜索 2 组，逐组展示状态、结果数、耗时、缓存复用和错误。每组最多保留 5 个来源；SearXNG 返回有效 arXiv 论文时，在来源限额内保留一个论文来源，避免论文因排在普通网页之后而被丢弃。各组结果按关键词顺序去重整理，最多保留 10 个来源，回复中展示标题、域名、链接和摘录。只有实际检索结果进入来源列表；模型正文中的链接并不代表经过搜索验证。可以在回复下方编辑关键词重搜，新请求保留旧回答。

`web-search.ts` 负责提供方调用、12 秒超时、1 MB 响应上限、HTTP(S) 链接校验、去重和脱敏。SearXNG 上游地址来自服务端 `SETDRAFT_SEARCH_URL`，Tavily 地址固定；客户端不能指定上游，禁止重定向，不抓取任意网页全文。外部摘录明确标为不可信资料，不授权执行其中的指令。

搜索与模型共用全站 AI 调度配额（全站 4 个、每人 1 个），关键词规划和回答分别记录模型用量。管理员连接测试须主动触发，每次实际请求上游，不使用缓存来假报连接成功。每人每日搜索额度默认 100，按实际搜索组计入 PostgreSQL；缓存按用户和查询隔离，15 分钟有效。升级后的新检索不复用加入 arXiv 之前的查询缓存。同一个聊天请求失败重试复用已经完成的关键词规划和检索结果。关键词生成失败或没有取得资料时继续普通回答，明确标记未使用网络资料；部分搜索失败时使用已有结果并提示。不生成虚假的来源列表，也不自动改用收费提供方。

SSE 的 `search` 事件包含 `planning`、`searching`、`complete`、`failed` 阶段及逐组进度，与模型事件共同持久化并按序回放；取消贯穿规划、搜索和回答。API 密钥只保存在服务器身份配置中；普通用户只看到可用状态。

SearXNG 仍依赖服务器到上游引擎的网络连通性。默认显式启用 Bing（`https://cn.bing.com`）、`360search` 与 arXiv，每个引擎超时 8 秒；可调整 `deploy/searxng/settings.yml`。arXiv 使用官方 API 检索论文标题与摘要，结果中的论文链接和摘要进入现有来源列表。arXiv 同时加入 `general` 分类，因此默认聊天搜索与部署预检都会查询它；英文论文关键词通常更适合论文检索。`use_default_settings.engines.keep_only` 只保留引擎，并不会覆盖它们默认的 `disabled: true`，因此还需在 `engines` 中配置 `disabled: false`。部分引擎超时或触发 CAPTCHA 时，只要其他引擎返回有效结果就继续使用；所有引擎不可用时明确报错，不伪造搜索成功。

内部 SearXNG 请求携带固定的服务端标识头 `X-Forwarded-For: 127.0.0.1` 和 `X-Real-IP: 127.0.0.1`，不读取或转发用户 IP，也不向 Tavily 发送这些头。搜索服务仅在 Compose 内网可达，限流在 Setdraft 内执行。`limiter.toml` 保留回环地址信任配置，不信任任意来源或扩大代理网段。缺少转发头的日志不是 DuckDuckGo/Brave 出站超时的原因。

## 搜索出站代理与更新

Compose 为搜索容器显式保存 DNS 上游，容器重启时使用已保存的地址。首次安装优先采用宿主机的非回环 DNS；宿主机 DNS 为空或只有回环地址时，`cn` 使用 AliDNS（`223.5.5.5`、`223.6.6.6`），`global` 使用 Cloudflare（`1.1.1.1`、`1.0.0.1`）。受限网络可在 `.env` 中指定容器可达的 DNS：

```dotenv
SETDRAFT_SEARCH_DNS_PRIMARY="10.0.0.53"
SETDRAFT_SEARCH_DNS_SECONDARY="10.0.0.54"
```

显式填写的地址保存在 `.env` 和 `.env.compose`，升级沿用既有设置。留空时，每次安装、升级或启动重新采用当前宿主机 DNS，将具体地址记录到 `.env.compose` 供容器再次启动使用；当前宿主机 DNS 暂未就绪时沿用上次记录。只指定第一项时，第二项沿用第一项；禁止回环或未指定地址。自动安装也支持宿主机没有 Node.js 的环境，DNS 信息由宿主机传入配置生成容器。新配置会重建原来依赖空 DNS 的搜索容器。

搜索容器的健康检查验证本地 JSON 接口及可用引擎目录；Web 等待该检查与 `search-check` 检索预检完成。`install`、`upgrade`、`start` 每次都重新执行预检：从部署网络直接检索固定的中英文公开查询，检查合法标题、链接与摘录，最多等待 60 秒恢复短暂网络故障。有可用来源时允许其他引擎部分失败。持续不可用时返回非零退出码，停止更新流程；预检在停止旧 Web 或清空数据之前执行。脚本完成预检后依次检查数据库、运行迁移、启动 Web，避免 Compose 在停止旧 Web 后再次运行已完成的检索预检。常规健康检查不重复查询上游，也不会自动切换到收费提供方。

原生安装与启动在配置了 `SETDRAFT_SEARCH_URL` 时执行同一检索预检；地址未配置时明确显示联网搜索不可用。预检不需要管理员登录，不访问模型或收费接口，也不使用应用缓存、搜索额度或私人关键词。

镜像下载代理、`--download-proxy` 都不等于搜索流量代理。出站网络受限时，在 `.env` 中单独设置自己的 HTTP(S) 代理：

```dotenv
SETDRAFT_SEARCH_PROXY="http://proxy.example.org:7890"
```

地址必须能从搜索容器访问；不要填写宿主机代理的 `127.0.0.1`，它在容器内指向容器自身。仅有 SOCKS 代理时，可直接在 SearXNG 的 `outgoing.proxies` 中按官方文档配置。不要将代理凭据提交到版本库或贴入日志。

更新到包含修复的源码和 Web 镜像后，按原安装方式运行 `./install.sh --keep-data`，它会重新生成 `.env.compose`，保留数据、代理配置并重建配置发生变化的服务；原来的源码构建模式也会保留。只有拉取镜像而不更新挂载的 `deploy/searxng` 配置不会修复旧引擎配置。原生安装不创建 SearXNG，需自行配置搜索服务的出站代理。

安装器将搜索配置、健康检查、预检脚本及 DNS/代理设置的哈希写入 Compose 服务标签。重新运行 `./install.sh --keep-data` 会检测变化并重建相关搜索容器。手工修改部署文件后，可通过以下命令完成配置更新、预检及启动：

```bash
./scripts/setdraft-compose.sh start
```

在管理页面选择“中文诊断”或“英文诊断”。诊断使用固定公开查询，绕过缓存，分别测试聚合接口与实际启用的引擎；arXiv 独立诊断使用固定英文论文关键词 `graph shortest path`。最多 8 个引擎、并发 4 个，沿用现有 AI 限额。报告展示检查时间、耗时、候选与接受数量，可下载脱敏 JSON。`POST /api/ai/search/diagnostics` 仅供管理员使用，参数为 `{"language":"zh"}` 或 `{"language":"en"}`，需要登录会话和 CSRF token。

配置就绪与最近搜索健康分别显示：`healthy` / `partial` 表示有可用来源；`no-match` 表示合法空结果；`engines-unavailable` 表示上游引擎不可用；`filtered-empty` 表示候选全部未通过 URL/内容校验。网络、超时、HTTP 错误和响应结构错误各自分类。无摘要但标题与 URL 合法的来源仍可接受，不编造摘要。诊断不包含搜索词、正文、密钥、代理凭据或原始上游错误。

SearXNG 的 `HTTP connection error` 属于网络连接错误。若所有引擎都在几毫秒内失败，可先检查搜索容器的 `/etc/resolv.conf` 与域名解析。旧容器显示 `NO EXTERNAL NAMESERVERS DEFINED` 时，运行上述启动命令会生成显式 DNS 配置并重建服务；修复不依赖特定发行版的 DHCP 或 systemd 服务。网络屏蔽外部 DNS 或搜索引擎时，需要配置可达的 DNS/搜索代理；安装器会报告预检失败。

普通聊天在对应回复附近保存和展示来源状态，未取得资料时明确显示“本次回复未使用网络资料”，刷新后仍可核对。若仍提示上游不可用，请检查搜索容器到上游引擎的连通性、代理是否可达以及是否遭遇 CAPTCHA；延长超时不能恢复被阻断的网络，也不会自动切换到收费服务。

## 定向回归

```bash
node --test scripts/check-search.test.mjs scripts/compose-config.test.mjs scripts/compose-installer.test.mjs scripts/hydro-local.test.mjs scripts/searxng.test.mjs
cd packages/hydro-server
node ../../scripts/test-server.mjs test/web-search.test.ts
```

SearXNG 测试使用固定镜像与隔离网络，验证实际启用的引擎、健康检查、DNS 失效与恢复、容器再次启动、代理传递及真实网络客户端；安装器测试验证预检失败时保留旧 Web 和数据。未安装 Docker 或缺少镜像时跳过容器测试。常规测试不依赖外网；在仓库根目录运行 `SETDRAFT_LIVE_SEARCH_TEST=1 node --test scripts/searxng.test.mjs` 可额外执行真实搜索，该检查仍取决于执行机器的出站网络。

参考：[Docker DNS](https://docs.docker.com/engine/network/#dns-services)、[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)、[SearXNG 搜索接口](https://docs.searxng.org/dev/search_api.html)、[服务配置](https://docs.searxng.org/admin/settings/settings_server.html)、[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。
