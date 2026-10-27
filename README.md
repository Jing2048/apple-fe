# 互动活动工程基础设施

“云朵邮局”已发布到 <https://jing-cloud-post-demo.fizzyllama25.chatgpt.site>，任何拿到链接的人均可打开，无需登录。正式域名已通过未登录浏览器完整试玩、真实保存和数据库读回。首页为原创可玩体验，旧工程台位于 `/lab`；发布版本与验证边界见 [Sites 部署记录](docs/sites-adaptation.md)，环境内截图/录屏与测试见 [云朵邮局验收](docs/cloud-post-acceptance.md)。

面向中国大陆、微信内置浏览器和 Safari 的活动开发基线。首页以原创体验贯通真实保存链路；`/lab` 使用占位素材验证两类通用交互、状态恢复、后端契约、第一方事件采集和可重复交付。

这里没有正式 Apple 页面、真实会员接口、抽奖或权益发放。外部适配器明确标为 `mock`；原 Fastify API 保留 `NODE_ENV=production` 启动保护，已托管版本仅用于 demo 验收。上传的 Keynote 尚未成功读取，技术探针不能视为其中具体玩法已验收。

当前已在本任务云环境部署编译后的完整容器栈。最新证据见 [部署验收](docs/deployment-acceptance.md)，整个项目的能力与扩展边界见 [能力映射](docs/project-capabilities.md)。测试页是验收入口，活动目录、契约、数据库和 SDK 可由后续页面复用。

## 本地开发

需要 Node.js 24、pnpm 11.25.0、Docker Engine 和 Compose。命令从仓库根目录执行。

```sh
test -f .env || cp .env.example .env
pnpm install --frozen-lockfile
docker compose -f infra/compose.yaml up -d --wait db
pnpm --filter @apple/api db:migrate
pnpm dev
```

开发页面使用 `http://localhost:5173`，Vite 将 `/api` 转发给 3001 端口。`APP_ORIGIN` 必须与实际浏览器来源完全一致；使用 `127.0.0.1`、另一个端口或远程域名时，要相应修改环境配置。同源写请求校验不会为调试自动关闭。

`/api/health` 证明进程存活；`/api/ready` 验证数据库和迁移可用。访问 `/api/campaigns/lab` 会建立匿名 HttpOnly 会话。接口契约见 `/api/openapi.json`。

## 自动化检查

```sh
pnpm check
pnpm test:integration
pnpm exec playwright install --with-deps chromium webkit
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e
```

`pnpm check` 包含原有 114 项单元/API 测试及 13 项 Worker Store 本地 SQLite 测试；真实 PostgreSQL 集成和浏览器 E2E 独立执行。Worker Store 可单独运行 `pnpm test:worker`、`pnpm typecheck:worker`。本地 SQLite 测试不等于远程 D1 验收。

验证已经部署的编译产物时设置 `E2E_BASE_URL=http://localhost:8080`，Playwright 将不启动开发服务器。首页完成互动后，展开“验收记录”独立读回当前会话的本轮事实；`/lab` 的“重发本轮请求”验证相同幂等键的回执不变。具体操作与性能复现见验收文档。

集成测试需要 `DATABASE_URL` 指向专用开发或测试数据库。不要指向生产数据。缺少数据库配置时集成测试会明确失败，不会静默跳过；浏览器报告也不等于真实微信或 Safari 验证。实际运行结果与未完成门禁记录在 [验证说明](docs/verification.md)。

## 容器化整栈验证

```sh
docker compose -f infra/compose.yaml up -d --build --wait
```

容器页面使用 `http://localhost:8080`，Nginx 同源提供静态页面与 `/api`。Compose 固定为开发用 `mock` 验证栈，使用仅供本地的数据库密码，所有映射端口仅绑定 `127.0.0.1`。这份配置不应直接用于生产。

前端的 `RELEASE_ID` 在构建时写入，只公开这个版本标识；API 在运行时读取它。Compose 同时把相同标识传入前端构建和 API 配置。修改版本需要重建并晋级对应制品，单独改变 API 运行环境不能改写已生成的前端版本。可用 `RELEASE_ID=lab-check-001 docker compose -f infra/compose.yaml up -d --build --wait` 验证一组一致的制品。

```sh
docker compose -f infra/compose.yaml logs --tail=100 api
docker compose -f infra/compose.yaml down
```

`down` 保留数据库卷。除非明确要丢弃本地数据，不要加 `--volumes`。

## 工程边界

```text
apps/web            中文验证台、状态机、资源与埋点适配
apps/api            契约校验、会话、事件持久化、外部适配器
apps/worker         共享 D1 Store、SQLite 迁移与测试（完整托管工程见部署记录）
packages/contracts  共享接口、事件和资源定义
infra               本地容器、API/web 制品、同源网关
tests/e2e           面向编译部署的跨应用浏览器验收
docs                决策、验证证据要求、运行与回滚
```

具体边界见 [架构](docs/architecture.md)，启动、迁移、备份和回滚见 [运行手册](docs/operations.md)。CI 配置已提供；工作流文件存在不代表 GitHub Actions 已运行。

## Sites 托管状态

`.openai/hosting.json` 仅保存 Site 身份，不含凭据。原仓库整栈仍为 Nginx + Fastify + PostgreSQL；`apps/worker` 保留独立 D1 Store、schema 和本地测试。已发布的官方 Vinext/Worker/D1 工程另存于该 Site 的私有 source repository，尚未回存本分支，不会替换原数据库或迁移已有开发数据。网页公开不改变源码访问范围，访客通过独立随机 Cookie 会话隔离，原私有数据不公开。

公开托管版的官方构建、类型检查及 8 项本地 Miniflare D1 测试通过，平台报告发布 `succeeded`。未登录云浏览器已完成三站六星、真实参与回执与数据库读回，本轮开始/完成事件各 1 条；这项线上验证与本地测试分别记录。远程并发/故障矩阵、Safari/微信真机及客户生产验收尚未完成。两个发布版本、源码基准与证据范围见 [Sites 部署记录](docs/sites-adaptation.md)。

仓库只提交源码、共享契约、锁文件、迁移、测试和必要交付配置。真实 `.env`、密钥、数据库/备份、依赖、构建产物、运行日志、截图及录屏不入库。`.env.example` 仅包含本地公开占位值，托管环境必须使用平台安全配置。

用户已确认开发和测试使用本任务云环境，项目位于 `/workspace/apple-fe`。无需迁移到其他电脑；项目不依赖用户 Mac 的文件路径。云端浏览器模拟不等于 Safari 或微信真机验证。
