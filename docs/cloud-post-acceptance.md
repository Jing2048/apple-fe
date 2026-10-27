# 云朵邮局：可玩体验验收

本任务云环境已经部署原创“云朵邮局”。首页 `/` 是可玩体验，工程验证台保留于 `/lab`。用户最新要求手机可直接访问的网页，因此**环境内可用不等于最终链接已交付**：外部托管发布仍待主对话的 Sites 能力及受支持的源码交付路径。

## 玩法与设计

陪原创 SVG 云朵邮差收集六颗星光，分三站、每站两颗；可以拖动云朵、触控轻点或键盘收集。没有倒计时、输赢和奖品。完成后可在三条原创祝福之间切换，生成纸质邮票卡视觉。

奶油纸张、天空蓝、珊瑚邮包与暖黄星光形成统一画面；重要文案使用可读字号，触控命中框稳定，漂浮只作用装饰 SVG。支持减少动态效果、暂停/继续、后台自动暂停和重新寄信。卡片文案只保留在浏览器，不发送邮件或第三方；后端保存的是实际参与回执，收到真实确认才显示“这封星光已保存”。

进行中刷新会恢复进度并暂停；完成后刷新或响应丢失，以原 round UUID 再向服务端确认。可选统计默认关闭，不启用也能完整游玩。技术回执、事件数量和数据库读回收在“验收记录”折叠区。

## 已执行

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

这些是验收证据，不替代用户要求的可点击网页链接。`localhost:8080` 仅属于当前云环境，不能当作用户手机地址。

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

当前完整编译栈仍为 Nginx + Fastify + PostgreSQL，web/API/数据库端口 8080/3301/5432，仅回环映射。真实 Apple/会员/奖品接口未接入，也没有真实邮寄。新页面为原创概念，不是未读取 Keynote 的复刻。

本环境没有 Sites 工具、技能、helper 或上传入口。项目已关联主对话注册的唯一 Site ID，普通 Git 访问该 Sites 源仓库因缺少原生认证而失败，已停止。用户另行授权将源码推送到原 GitHub 仓库独立分支，供主对话接线。主对话的 Sites 可提供 Worker/D1，但不支持当前 Postgres TCP；独立 D1 Store、迁移与 13 项本地 SQLite 测试已实现，托管 HTTP/资源/绑定/迁移配置及远程验收仍未完成，见 [适配状态](sites-adaptation.md)。不能仅部署静态页面并伪造保存成功。用户已经明确授权供其访问的托管发布，无需再把发布授权当作阻塞。
