# 基础版历史验收记录

本文件保留最初基建版本的验收记录。当前版本已增加活动目录边界与真实数据库读回，并直接测试编译后的容器部署；最新结果与复现命令以 [deployment-acceptance.md](deployment-acceptance.md) 为准。历史通过数量不是当前版本的最终统计。

运行位置：当前任务的云端 Linux，项目绝对路径 `/workspace/apple-fe`。用户已确认在本任务云环境进行开发和测试，无需迁移到其他电脑，跨环境移交不再是验收条件。未使用用户 Mac。

## 实际通过

- `pnpm check`：格式、ESLint、应用与测试工具类型检查、资源清单、77 项单元/API 注入测试、构建及体积预算通过。其中 contracts 9、web 28、API 40。
- `pnpm test:integration`：15 项真实 PostgreSQL 集成通过。测试在独立临时 schema 运行并清理，不以内存库代替。
- Chromium 桌面与移动布局：22/22 E2E 通过。移动布局是浏览器模拟，不是手机或微信真机。
- 两应用镜像实际构建成功，保留的 `scripts/smoke-container.mjs` 验证 10 项通过。
- 实际重启本项目数据库容器后，既有回执整行 SHA-256 保持一致；API 自动重连并恢复 ready。未删除卷。
- 开发库已实际执行 `pg_dump -Fc` 并在隔离新库恢复，4 条事件、10 条参与记录对账一致。该记录是当时备份验证的样本数，不是当前库总数；私有快照不进入移交包。
- 生产依赖审计返回 info/low/moderate/high/critical 均为 0；这只是本次查询结果，不是永久安全保证。
- `pnpm install --frozen-lockfile` 成功；保存的云安装步骤亦在本机实际执行。

原始运行输出保存在 `.artifacts/check.log`、`.artifacts/integration.log`、`.artifacts/install-frozen.log`、`.artifacts/cloud-install.log`。浏览器完整报告为 `playwright-report/index.html`、`test-results/results.json`。容器、重启与体积数据分别为 `.artifacts/container-smoke.json`、`.artifacts/database-restart.json`、`.artifacts/build-budget.json`。

## 从问题到独立证据

| 专家要验证的问题               | 原始输入/行为                                    | 实现与检验方法                                                          | 可复现的证据                                            |
| ------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| 快速滑动是否漏掉采样间目标     | 原始指针轨迹、零长度、切线、反向与分段轨迹       | 线段/圆最近距离算法；1,000 组固定种子性质验证；真实浏览器单步跨目标拖动 | pointer 单测与 E2E                                      |
| 暂停、取消和重开能否破坏状态   | 连续输入、重复收集、后台切换、无效与乱序时间     | 纯 reducer；5,000 步固定种子状态序列；显式恢复，不自动继续游戏          | machine 单测与浏览器状态测试                            |
| 网络失败是否多记一次参与       | 服务端写入后丢弃响应；刷新；重复提交             | 先保存最小本地轮次草稿，签名会话 + 数据库唯一约束，重试同一幂等键       | 同一 receipt UUID；HTTP/PG 集成；刷新 E2E               |
| 事件重试是否可对账             | 相同事件重复、冲突内容、反向重叠并发批次         | 白名单 schema；稳定内容 fingerprint；事务；固定锁顺序                   | 30 并发仅一次 accepted；冲突回滚；20 重叠批次无死锁     |
| 同意与送达是否被混淆           | 未同意、撤销中的请求、迟到 ACK、Beacon 返回 true | 有界内存队列，撤销取消请求；仅 ACK 后出队，Beacon 不当作持久化          | SDK 单测和同意/撤销 E2E                                 |
| 素材真正就绪还是只有配置成功   | 占位 SVG 原始字节、404、错误大小、解码和取消     | SHA-256 文件名与大小校验；真实 fetch + Image 解码；失败重试             | assets:check、loader 测试、资源 404 E2E、容器 CSP smoke |
| 发布制品与浏览器实际行为一致吗 | 编译版本、同源请求、缓存和 CSP 响应头            | 版本白名单注入；Nginx 实际运行；回执与埋点版本对账                      | container-smoke.json、截图与可重跑脚本                  |

## 实际发现与修复

1. Query 轮询失败仍保留旧 data，可能把历史成功展示成当前就绪。改为按当前成功状态控制开始并优先展示错误；先成功后 503 的 E2E 已通过。
2. 浏览器真离线时，TanStack mutation 会等待联网，不能显示“正在服务端记录”。现在明确显示离线等待，联网后使用同一轮次自动提交；网络请求失败仍提供手动重试。两个分支分别测试。
3. Nginx CSP 初始不允许图片解码使用的 blob URL，只有容器才会暴露。仅为 img-src 加入 blob:，真实解码验证通过。
4. 非 root Nginx 无法读取云环境默认 0600 的配置。构建时显式设置所有权与读取权限，未改为 root 运行。
5. 公共占位资源原先缺少内容哈希，不能安全长期缓存。资源改为 SHA-256 文件名；缺失资源及 source map 返回 404 且不带 immutable。
6. 读取根 `.env` 的 Vite loadEnv 会影响 production build mode。改用 Node parseEnv 纯读取一个公开版本字段，增加 3 项环境隔离回归。相同测量脚本实际输出的 JS gzip 从 **165,888 B 降为 101,195 B**，CSS 为 **4,437 B**；没有通过放宽预算或隐藏警告解决。构建体积不是现场 LCP/INP 证据。

## 复现入口

按 README 准备 Node 24.19.0、pnpm 11.25.0、开发数据库及 `.env`：

```sh
pnpm check
pnpm test:integration
pnpm exec playwright install --with-deps chromium webkit
PLAYWRIGHT_WEBKIT=1 pnpm test:e2e
```

当前受限云环境使用已有 `/usr/bin/chromium`，实际执行浏览器检查时设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`。本云下载 `cdn.playwright.dev` 被网络策略 403 拒绝，因此本次没有运行 WebKit；没有绕过该拒绝。

本云 pnpm 缓存不能写入 HOME；命令前设置以下路径。普通开发电脑不必使用这些云端路径：

```sh
export XDG_DATA_HOME=/workspace/.cache/apple-pnpm/data
export XDG_CACHE_HOME=/workspace/.cache/apple-pnpm/cache
export XDG_STATE_HOME=/workspace/.cache/apple-pnpm/state
```

当前容器服务端口为 web 8080、API 3301、数据库 5432，仅回环映射。可在这台机器执行：

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node scripts/smoke-container.mjs
```

## 明确未完成

- Keynote 原始 demo 未读到；当前两种通用探针没有被冒充为具体创意算法验收。
- WebKit、Safari/微信真机、实际渠道网络和现场性能尚未验证。
- 真实会员、Apple、奖品或订单提供方未接入，production mock 门禁保持关闭。
- GitHub Actions 文件已准备但没有推送/触发远程运行；无生产发布、采购或真实凭据配置。
- 峰值流量未给定；未运行生产容量压测。网关后的限流仍是 lab 单实例安全默认，不能宣称生产多用户限流完成。
- 尚无生产级事件保留/删除任务、真实分析平台或外部 APM 配置；日志与技术探针事件可在本地追溯。
