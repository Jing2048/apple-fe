# Sites 部署记录与验收边界

正式地址：<https://jing-cloud-post-demo.fizzyllama25.chatgpt.site>。当前访问范围为 **public，免登录**，任何拿到链接的人均可打开。该变更由用户明确授权，沿用原 Site 和域名，不新建站点。

以下部署信息和线上验证由主对话通过官方 Sites 工具与云浏览器回传；本次仓库更新只记录结果，不触发重新部署。

## 当前公开版本

| 字段                | 已发布值                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| Site project        | `appgprj_6ae034ff0764819191d1058131dd870f`                                          |
| Sites source commit | `22ef72933c7b19559d3558159259aef2a7928eae`                                          |
| Deployment          | `appgdep_6ae03dc848288191ada0112496790f08`                                          |
| Version             | `appgprj_6ae034ff0764819191d1058131dd870f~appgver_eafc55b02dac81918294ba4903171bd8` |
| 平台状态与时间      | `succeeded`，2026-10-27 05:59:43 UTC                                                |
| 访问范围复核        | `public`，revision `2`；2026-10-27 05:59:55 UTC                                     |
| 原 GitHub 源码基准  | `c9ee5a7c658e8d9c7e8516eded543cccb2b8b870`                                          |

## 首版私有发布历史

以下是同一 Site 的历史版本，访问范围已由当前公开版本取代，不再要求访客登录。

| 字段                | 私有首版                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| Sites source commit | `7778d3fa05d7babb9748c2694222f46c203587e4`                                          |
| Deployment          | `appgdep_6ae03ca8fa1c81919c07aa485ab883b8`                                          |
| Version             | `appgprj_6ae034ff0764819191d1058131dd870f~appgver_9f67f0fde5bc8191883bf8570c143140` |
| 平台状态与时间      | `succeeded`，2026-10-27 05:55:01 UTC                                                |
| 当时访问与验证      | `owner-private`；正式 URL 仅检查到登录门，未代用户登录                              |

## 原仓库与托管代码边界

- 本仓库 `.openai/hosting.json` 保留同一 Site 身份。原 Nginx + Fastify + PostgreSQL 栈、迁移与开发数据保持独立，未被上传成托管 PostgreSQL 服务，也未被覆盖。
- 托管打包工程位于主对话环境的 `/workspace/shared/cloud-post-site`，经官方 Sites source helper 保存到该 Site 的私有 source repository；该路径不属于本任务工作区。托管适配尚未回存本 GitHub 分支，不能把当前分支直接当作完整的 Sites 发布工程。
- 托管工程按官方 Vinext 模板接入 Worker/D1、schema/迁移 journal。私有首版使用平台 owner 身份与不透明 Cookie 会话；公开版改为每个访客独立的随机 Cookie 会话，不使用共享匿名身份，不暴露私有首版数据。本次公开迭代没有 schema 迁移变化。
- 部署执行方核对了 25 份复用源文件的字节一致性。Sites 不支持原 PostgreSQL TCP 栈，托管服务采用独立 D1 持久化，不迁移原开发记录。公开网页不等于公开源码或数据库。
- 原 GitHub 独立分支承载共享源码和测试；Sites source commit 承载本次实际发布工程。两者提交 ID 不同，均应保留以追溯对应制品。真实 Apple/会员接口仍为 mock，没有奖品发放或实际邮寄。

## 托管打包环境验证

部署执行方报告：当前公开版官方构建和 TypeScript 类型检查通过，8 项真实本地 Miniflare D1 测试通过；私有首版曾通过 7 项。覆盖并发幂等、冲突回滚、隔离、CSRF、会话过期与重启，并补充公开匿名会话隔离验证。原始验证材料保留于主对话托管打包环境，本次文档更新不复制日志或运行数据。

这些测试运行在本地 Miniflare，不是线上远程 D1 并发、事务与故障矩阵的实证。正式域名的真实浏览器链路验证单独记录如下。

## 正式域名浏览器验收

主对话云浏览器在未登录状态访问同一正式 URL，实际完成：

1. 显示首屏，同意匿名体验统计并开始互动。
2. 完成三站六颗星光，进入祝福卡完成态。
3. 由真实服务端回执确认“这封星光已保存”。
4. 点击核验，显示“已从数据库读回”；本轮共 2 条事件：`interaction_started` 1 条、`interaction_completed` 1 条。

读回的查询时间为 `2026-10-27T06:01:34.272Z`。这是已发布域名上的真实浏览器 → API → D1 保存与读回，未使用 localhost 或模拟保存；外部 Apple/会员接口仍为 mock。记录中不包含实际 Cookie、会话标识或个人内容。

## 已实现的独立持久化适配

- `apps/worker/src/d1-store.ts`：实现原 Store 契约，通过 Web Crypto 计算 payload fingerprint，使用标准 D1 `prepare/bind/all/batch` 接口。
- `apps/worker/migrations/0001_core.sql`：独立 SQLite schema，只在迁移阶段执行；不在请求中建表。
- `apps/worker/tests/d1-store.test.ts`：13 项测试使用 Node 24 `node:sqlite` 与真实文件数据库，覆盖幂等、重复计数、整批回滚、归属隔离、UUID 规范化和重开持久性。

复现：`pnpm test:worker`、`pnpm typecheck:worker`；已纳入根目录 `pnpm check`。这 13 项测试属于原仓库的 Node SQLite facade，与托管工程当前 8 项 Miniflare 测试分别记录；二者都不替代远程 D1 的跨实例并发、网络、配额与错误格式验证。

## 托管适配的职责

| 部分                                        | 处理                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| React/Vite 体验、SVG、样式、键盘/触控和恢复 | 复用 React 源码，按官方 Vinext 模板重新构建；保持 `/` 与 `/lab`，不降级静态假保存                        |
| TypeBox 契约、活动目录和领域规则            | 复用；不得放宽活动注册、事件白名单或当前会话权限                                                         |
| 前端 API/可选遥测                           | 继续同源 `/api`，接口与隐私语义保持一致                                                                  |
| HTTP 服务                                   | 增加 Worker 请求适配器；不能将 Fastify Node 服务假定为 Worker 可运行                                     |
| 数据持久化                                  | 增加实现现有 Store 接口的 D1 adapter 与独立 SQLite 迁移；原 PostgreSQL adapter/迁移和测试保留            |
| 会话与 fingerprint                          | 使用 Worker 支持的密码学实现及服务端验证的独立随机 Cookie 会话；不复用本地公开开发 secret 或共享匿名身份 |
| 静态资源与入口                              | 官方 Sites 静态资源/入口、同源 Worker API 与缓存配置；当前已按用户授权开放免登录访问                     |

托管工程将这些职责限制在部署 adapter 边界，不替换原数据库或另写一套玩法；其实际版本以上述 Sites source commit 为准。本仓库继续保留原始开发、容器和测试链路。

## 不能省略的正确性检验

1. 参与记录的唯一键仍是服务器验证的会话 + 活动 + 幂等键；重复并发、响应丢失和刷新必须返回同一回执。原 PG API 的签名 Cookie、私有首版的平台身份会话及公开版独立随机 Cookie 是不同运行时适配，不应混称。
2. 事件须按服务器验证的会话归属；不能信任客户端 sessionId。按 owner + campaign + round 读回，跨会话和跨活动不能串数。
3. D1/SQLite 事务语义需要实际验证：整个事件批次原子执行，相同 ID 不同内容使整批回滚。不能把多次 await 当成 PostgreSQL begin 的替代。`batch` 与条件约束/RETURNING 的可用性须根据工具文档和真实执行结果确认。
4. 重复事件的 accepted/duplicates 计数要与原契约一致；SQLite affected-row 计数不能未经检验直接当作“新插入”。保留 payload/fingerprint 不可变的语义。
5. 原 JSON schema 运行时校验、128 KiB 请求限制、50 事件上限、来源检查、统一脱敏错误和 no-store 必须保留。多实例限流能力不能沿用单进程 Map 后宣称已实现。
6. Site Cookie 需要 Secure/HttpOnly/SameSite；APP_ORIGIN 使用真正发布来源，不从任意客户端头反射。发布凭据与会话 secret 通过支持的安全配置提供，不进源码/聊天。
7. 发布后必须从实际域名验证资源、交互、真实 D1 保存与读回；当前公开版已通过上述完整试玩。远程并发、冲突、会话/活动隔离及离线/刷新恢复仍需分别验证，不能沿用私有首版 owner 登录的安全假设或将本地矩阵视为线上通过。

## 尚未覆盖的线上验收

正式域名的单次完整试玩与数据库读回已通过。远程并发幂等、冲突错误映射、整批回滚、跨访客/活动隔离、响应丢失/刷新及离线恢复尚无完整线上矩阵记录；不以本地 SQLite 或 Miniflare 结果替代。

用户已获得同一链接与免登录确认。Safari/微信真机、中国大陆网络可达性与公网性能尚未验证，也未进行客户生产验收。本次为文档回填，不修改代码、权限或部署。
