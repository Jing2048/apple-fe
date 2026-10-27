# 私有 Sites 适配状态（尚未发布）

## 当前事实

- 项目现已原子保存 `.openai/hosting.json`，关联唯一 Site `appgprj_6ae034ff0764819191d1058131dd870f`。当前环境仍没有 Sites skill/helper、Wrangler CLI或上传工具。
- 本任务的云环境配置工具保存环境设置，不能托管网页。没有重复新建 Site、猜地址或改变代码可见性。用户现已授权将去密源码提交到 `Jing2048/apple-fe` 独立开发分支，用于主对话读取并接线；不得覆盖或合并 `main`。
- 主对话确认 Sites 提供 owner-private 网站、Worker HTTP 与 D1，不提供 raw TCP。因此不能原样运行 Fastify/Postgres 容器，也不能从外部 Worker 访问本云的回环 API。
- 原 PostgreSQL 数据库、迁移与开发记录保持独立。已实现 D1 Store 和 schema 迁移，但尚未实现托管 HTTP 入口和发布配置。主对话已注册唯一 owner-private Site 并给出无 token 源仓库地址。对该 Sites 源仓库的普通 Git 只读访问已实际失败：`could not read Username for https://git.chatgpt-team.site: terminal prompts disabled`。该路径已停止，未猜凭据；短期 http_extra_header 未通过聊天接收。原 GitHub 仓库的独立分支是用户另行授权的交付路径。

## 已实现的独立持久化适配

- `apps/worker/src/d1-store.ts`：实现原 Store 契约，通过 Web Crypto 计算 payload fingerprint，使用标准 D1 `prepare/bind/all/batch` 接口。
- `apps/worker/migrations/0001_core.sql`：独立 SQLite schema，只在迁移阶段执行；不在请求中建表。
- `apps/worker/tests/d1-store.test.ts`：13 项测试使用 Node 24 `node:sqlite` 与真实文件数据库，覆盖幂等、重复计数、整批回滚、归属隔离、UUID 规范化和重开持久性。

复现：`pnpm test:worker`、`pnpm typecheck:worker`；已纳入根目录 `pnpm check`。本地 facade 用真实 SQL 事务模拟 D1 batch；它不证明远程 D1 的跨实例并发、网络、配额、错误格式或真实绑定。尚无可部署的 Worker 包、官方 Sites 模板接线或远程执行结果。

## 可复用与必要适配

| 部分                                        | 处理                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| React/Vite 体验、SVG、样式、键盘/触控和恢复 | 直接复用构建，保持 `/` 与 `/lab`；不另起前端或降级静态假保存                                                      |
| TypeBox 契约、活动目录和领域规则            | 复用；不得放宽活动注册、事件白名单或当前会话权限                                                                  |
| 前端 API/可选遥测                           | 继续同源 `/api`，接口与隐私语义保持一致                                                                           |
| HTTP 服务                                   | 增加 Worker 请求适配器；不能将 Fastify Node 服务假定为 Worker 可运行                                              |
| 数据持久化                                  | 增加实现现有 Store 接口的 D1 adapter 与独立 SQLite 迁移；原 PostgreSQL adapter/迁移和测试保留                     |
| 会话与 fingerprint                          | 使用 Worker 支持的密码学实现（例如 Web Crypto HMAC/SHA-256）及平台安全绑定；不得将本地公开开发 secret 用于托管    |
| 静态资源与入口                              | 按 Sites 技能配置静态资产/SPA fallback、同源 Worker API、缓存和 owner-private 访问；实际返回 URL 才能作为手机入口 |

预计为一个部署 adapter 边界：Worker 路由/运行时配置、D1 Store、D1 初始化迁移、对应验证及 Sites 受支持的构建配置。不是替换原数据库或另写一套玩法。

## 不能省略的正确性检验

1. 参与记录的唯一键仍是签名会话 + 活动 + 幂等键；重复并发、响应丢失和刷新必须返回同一回执。
2. 事件须按签名 Cookie 归属；不能信任客户端 sessionId。按 owner + campaign + round 读回，跨会话和跨活动不能串数。
3. D1/SQLite 事务语义需要实际验证：整个事件批次原子执行，相同 ID 不同内容使整批回滚。不能把多次 await 当成 PostgreSQL begin 的替代。`batch` 与条件约束/RETURNING 的可用性须根据工具文档和真实执行结果确认。
4. 重复事件的 accepted/duplicates 计数要与原契约一致；SQLite affected-row 计数不能未经检验直接当作“新插入”。保留 payload/fingerprint 不可变的语义。
5. 原 JSON schema 运行时校验、128 KiB 请求限制、50 事件上限、来源检查、统一脱敏错误和 no-store 必须保留。多实例限流能力不能沿用单进程 Map 后宣称已实现。
6. Site Cookie 需要 Secure/HttpOnly/SameSite；APP_ORIGIN 使用真正发布来源，不从任意客户端头反射。发布凭据与会话 secret 通过支持的安全配置提供，不进源码/聊天。
7. 发布后必须从返回的实际域名验证资源、交互、真实 D1 保存、读回、并发幂等、隔离及离线/刷新恢复。owner-private 的身份验证由平台支持流程完成，不能为测试擅自开放成匿名站点。

## 交付依赖

唯一 user_requested、owner-private Site 已由主对话注册，本环境不得重复注册。Sites 源仓库无原生认证，停止重试。用户已另行授权推送原 GitHub 仓库的唯一独立分支以移交源码，不包括合并、改权限或上传运行时数据；主对话可从该源码继续使用自己的官方 Sites 模板与受支持认证发布。

如果只能静态托管、不能提供实际 HTTP 后端/D1，发布条件仍未满足。官方模板、构建/静态资源集成、安全绑定和远程验收仍待接线。完成前不宣称可访问链接或托管全链路已经交付。
