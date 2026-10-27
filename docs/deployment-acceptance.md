# 运行环境部署验收

本文件记录基础设施前一轮部署验收。当前已加入原创云朵邮局，入口与新增测试以 [cloud-post-acceptance.md](cloud-post-acceptance.md) 为准；历史性能对比保留为实测记录，不冒充新页面的测量值。

本任务云端 Linux 是用户确认的开发测试环境，项目路径 `/workspace/apple-fe`。无需迁移电脑，也不要求公网发布。已运行的是实际编译产物：Nginx 静态页面 → 同源 API → PostgreSQL；验收不是用 Vite/MSW 替代这条部署链路。

## 运行状态与复现

三个容器为 `apple-lab-web-1`、`apple-lab-api-1`、`apple-lab-db-1`。仅回环端口分别为 web 8080、API 3301、PostgreSQL 5432；浏览器路径经过 web 的 `/api` 网关。API 实际命令为 `node apps/api/dist/index.js`。前端、API 和事件 release 均为 `local-container`；镜像完整 ID 见 `.artifacts/deployment-manifest.json`。

普通 Docker 主机可从根目录执行以下流程。本云若构建受企业代理影响，应按 operations.md 使用既有代理和临时 CA secret，保持 TLS 校验；本任务已实际完成该构建。

```sh
export RELEASE_ID=local-container API_PORT=3301 WEB_PORT=8080
docker compose -f infra/compose.yaml build api web
docker compose -f infra/compose.yaml up -d --no-build --wait
E2E_BASE_URL=http://localhost:8080 pnpm test:e2e
node scripts/smoke-container.mjs
node scripts/check-database-facts.mjs
```

本云执行 pnpm 前需按 evidence.md 设置可写 XDG 路径，浏览器命令还需 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`。`E2E_BASE_URL` 会关闭 Playwright 的开发服务器启动，只测试既有部署。普通主机应先安装 Playwright 浏览器。

在本环境打开页面后：可选同意体验埋点 → 开始并完成点击或滑动 → 核验数据库记录 → 重发本轮请求。拒绝埋点仍能保存参与记录，读回零事件是合法结果。数据库核验只返回当前签名会话的回执和聚合，不返回他人会话或原始事件。

## 当前通过的验收

- `pnpm check`：101 项单元/API 测试（contracts 13、web 38、API 50），以及格式、lint、类型、资源清单、编译和体积预算。
- 真实 PostgreSQL 集成 22 项：包含跨活动相同幂等键隔离、未知活动整批拒绝、会话归属、真实 HTTP 到数据库、迁移与并发约束。
- **已部署容器的浏览器 E2E 36/36**：桌面与移动布局 Chromium，无跳过、无重试通过项；覆盖两种探针、读回、重复提交、断网、响应丢失刷新、跨会话隔离和迟到响应。
- 容器功能 smoke 15/15；直接 SQL 对账确认一个实际回执、两条本轮事件、三条当前会话事件，且三项迁移已应用。
- 当前部署的数据库重启后，回执与本轮事件整体 SHA-256 保持一致；API 自动重连并 ready。只重启本项目 DB，未删除卷。

原始文件：`.artifacts/final-project-check.log`、`final-project-integration.log`、`deployed-e2e.log`、`container-smoke.json`、`persisted-flow-check.json`、`deployed-restart.json`、`deployment-manifest.json`，以及 `playwright-report/index.html` 和 `test-results/results.json`。截图为 `.artifacts/container-desktop.png`、`container-mobile.png`。

## 性能原始基线和调优

测量脚本为 `scripts/measure-deployment.mjs`。条件：同机 loopback 经 Nginx，Linux x64、Chromium 154.0.8037.57、CPU cgroup 配额 4 核、内存上限 32 GiB；每次新浏览器上下文，无人为网络或 CPU 节流。桌面 1440×1000、移动布局 390×844，各 3 次。接口并发 1/5；健康与 ready 各 10 个样本，新回执写入和读回各 5 个样本。

真实部署初测发现 gzip 请求仍收到 identity。仅启用 Nginx 静态 gzip 后，**同一路径、同一解码后 SHA-256** 的 JS，从 348,064 B 降到 104,723 B，实际传输减少 69.91%，并保留 immutable 与 `Vary: Accept-Encoding`。没有通过修改文件内容或放宽预算制造收益。

最终实验室样本：

| 指标                     | 条件            |         中位数 |
| ------------------------ | --------------- | -------------: |
| 自动化观察到可开始的时间 | 桌面            |       303.6 ms |
| 自动化观察到可开始的时间 | 移动布局        |       274.8 ms |
| 点击输入到第二个动画帧   | 桌面 / 移动布局 |   均为 16.0 ms |
| 新回执持久化请求         | 并发 1 / 5      | 5.18 / 9.45 ms |
| 回执数据库读回请求       | 并发 1 / 5      | 4.32 / 7.07 ms |

点击到第二帧不是 INP；可开始观测含自动化观察开销。样本很小且网络为同机，不据此声称真实用户 p75、手机性能、公网延迟、生产容量或 SLA 达标。静态构建预算仍为 JS gzip 200 KiB、CSS gzip 30 KiB。

原始时间与传输数据为 `.artifacts/deployment-performance-before-gzip.json` 和 `deployment-performance-after-gzip.json`，包含样本、条件、文件 hash 和接口结果。可用 `PERF_LABEL=baseline node scripts/measure-deployment.mjs` 重测当前部署；这会创建少量明确的开发参与记录。

## 能力与限制

整个项目的可复用边界见 [project-capabilities.md](project-capabilities.md)。正式素材/玩法、真实 Apple/会员接口、客户生产基础设施和真机验收尚未完成。当前前端是正式构建产物，后端也是编译产物，但提供方仍是明确的 mock，production 模式仍拒绝启动，不声称已可生产上线。

当前工具没有用户端口转发入口；本机地址不是用户电脑的 localhost。可通过任务文件面板查看截图和报告；若平台提供本环境终端，则可同机访问 8080。用户已确认不以公网链接为部署验收前提，没有为此新建隧道、修改权限或公开服务。
