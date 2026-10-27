# 云朵邮局：可玩体验验收

原创“云朵邮局”已提供正式公开入口：<https://jing-cloud-post-demo.fizzyllama25.chatgpt.site>，任何拿到链接的人均可打开，无需登录。首页 `/` 是可玩体验，工程验证台保留于 `/lab`。以下游戏与浏览器测试证据来自本任务云环境的编译容器栈；正式域名的完整试玩、两个发布版本和剩余验证边界见 [Sites 部署记录](sites-adaptation.md)。

## 玩法与设计

陪原创 SVG 云朵邮差收集六颗星光，分三站、每站两颗；可以拖动云朵、触控轻点或键盘收集。没有倒计时、输赢和奖品。完成后可在三条原创祝福之间切换，生成纸质邮票卡视觉。

奶油纸张、天空蓝、珊瑚邮包与暖黄星光形成统一画面；重要文案使用可读字号，触控命中框稳定，漂浮只作用装饰 SVG。支持减少动态效果、暂停/继续、后台自动暂停和重新寄信。卡片文案只保留在浏览器，不发送邮件或第三方；后端保存的是实际参与回执，收到真实确认才显示“这封星光已保存”。

进行中刷新会恢复进度并暂停；完成后刷新或响应丢失，以原 round UUID 再向服务端确认。可选统计默认关闭，不启用也能完整游玩。技术回执、事件数量和数据库读回收在“验收记录”折叠区。

## 本任务编译容器栈已执行

- 类型、lint、格式、构建和预算通过；114 项单元/API 测试（contracts 13、web 50、API 51）。
- 23 项真实 PostgreSQL 集成通过；新增 cloud-post，继续保留 lab 与未知活动拒绝、跨活动幂等/事件隔离。
- 50/50 编译部署 E2E 通过，零跳过、零失败、零重试通过。原有 36 项保留断言，仅将工程页目标改为 `/lab`；新增 14 项覆盖原创体验。
- 新体验覆盖六星与实际保存、文案不出网、三颗星后刷新暂停、响应丢失刷新同回执、离线恢复、键盘/后台暂停/重开、加载失败重试及真实 Chromium 触控分支。
- 桌面真实拖动和移动触控模拟分别录制 20.1 秒 WebM；每段 201 解码帧，经 ffprobe 验证。录屏来自实际 CDP 帧流与系统 FFmpeg，不是静态图合成；均完成真实 POST 回执与独立 GET 读回，JS 错误为 0。

本轮没有新增框架或重型动画依赖，也没有修改数据库迁移。主页按路由懒加载，工程页样式与 UI 不占据普通用户首屏。

## 查看实际画面

任务文件面板中的实际部署截图：

- `.artifacts/cloud-post-mobile-first.png`、`cloud-post-mobile-playing.png`、`cloud-post-mobile-complete.png`
- `.artifacts/cloud-post-desktop-first.png`、`cloud-post-desktop-playing.png`、`cloud-post-desktop-complete.png`
- 实际录屏：`.artifacts/cloud-post-desktop.webm`、`cloud-post-mobile.webm`

这些是环境内验收证据，不是正式站点截图或录屏。手机访问使用上方 Sites 正式链接；`localhost:8080` 仅属于当前云环境。

## 复现与测量

```sh
E2E_BASE_URL=http://localhost:8080 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:e2e
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node scripts/capture-cloud-post.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium PERF_PAGE_PATH=/ PERF_LABEL=cloud-post node scripts/measure-deployment.mjs
```

构建预算实测：全部 JS chunks gzip 115,785 B，全部 CSS gzip 11,459 B，分别低于 200 KiB / 30 KiB。页面没有外部字体或图片服务。

当前部署测量条件：Linux x64、Chromium 154、同机回环经 Nginx、无 CPU/网络节流，每次新上下文。桌面 1440×1000、移动模拟 390×844，各 3 次：自动化观察到可开始的中位数约 964 / 959 ms；点击输入到第二帧均约 27.2 ms；初始及操作阶段记录到的资源编码体积为 115,658 B。观测含自动化开销，第二帧时间不是 INP，不代表真实手机、公网、Safari/微信或用户 p75。

原始报告：`.artifacts/cloud-post-check.log`、`cloud-post-integration.log`、`cloud-post-deployed-e2e.log`、`cloud-post-capture.json`、`cloud-post-capture-run.json`、`deployment-performance-cloud-post.json`、`cloud-post-delivery.json`；浏览器报告为 `playwright-report/index.html` 和 `test-results/results.json`。

## 发布边界

本任务云环境的完整编译栈仍为 Nginx + Fastify + PostgreSQL，web/API/数据库端口 8080/3301/5432，仅回环映射；独立托管版本采用官方 Vinext + Worker + D1，没有把原 PostgreSQL 服务发布到外网。真实 Apple/会员/奖品接口未接入，也没有真实邮寄。新页面为原创概念，不是未读取 Keynote 的复刻。

主对话基于 GitHub 源码基准 `c9ee5a7c658e8d9c7e8516eded543cccb2b8b870` 接线并通过官方 Sites 工具发布，公开版 source commit 为 `22ef72933c7b19559d3558159259aef2a7928eae`，平台状态为 `succeeded`、访问范围为 `public`。官方构建、类型检查及 8 项本地 Miniflare D1 测试通过。

正式域名的未登录云浏览器已实际完成首屏、同意匿名统计、三站六星、祝福卡、真实保存回执及数据库核验。本轮读回 2 条事件（开始/完成各 1），查询时间 `2026-10-27T06:01:34.272Z`。这证明该线上试玩链路通过；远程并发、故障恢复、完整隔离矩阵、Safari/微信真机与客户生产验收不在该结论范围内。本页原有本地测试数量与性能数据不得解读为正式站点实测。
