# 新春云朵邮局

独立新年主题以“把新意，带回家”为主线，三站围绕迎新、团圆、心愿展开。它复用原版六星收集、连续拖动、暂停/恢复、三张卡片、本机记录及可选相机实景叠加，不新增业务服务或外部依赖，也不修改已上线 Site。

## 视觉与参考

参考 [Apple 官方春节特别款 AirPods 产品页面](https://www.apple.com/hk/shop/product/MDF24ZP/A/special-edition-airpods-4) 的留白、文化符号集中与主体突出原则。此处不使用 Apple 标识、官方图形或素材，不暗示联名，不绑定生肖或具体年份。

本项目原创配色：暖纸白 `#F8F3E9` 为主要背景，朱砂红 `#B82025` 用于 CTA 与重点，香槟金 `#D8B46A` 只作愿望星、光点和细线，暖墨 `#281B19` 用于正文。比例目标约为暖白 70%、红色重点 20%、金色少于 10%；这些不是从 Apple 页面提取的官方色值。

保留原创云邮差轮廓，通过克制的红色服饰/邮封细节和金色愿望星建立节庆感。完成态为祝福邮笺，不增加促销弹窗、奖品承诺或堆叠装饰。没有外部字体、图像或重型动画依赖；减少动态效果设置继续生效。

## 构建与并存

```sh
pnpm install --frozen-lockfile
pnpm build:offline:new-year
```

单文件输出 `.artifacts/offline/cloud-post-new-year.html`，大小和 SHA-256 记录于 `.artifacts/offline/new-year-build.json`。原版仍用 `pnpm build:offline`，输出 `cloud-post-offline.html` 与 `build.json`，不会被新年构建覆盖。生成文件不提交 Git。

两个版本的记录与草稿分别使用 `cloud-post.offline.v1.*` 和 `cloud-post.offline.new-year.v1.*`；不迁移旧数据。选择器、卡片与历史列表共用本主题的固定三项祝福，避免把原版索引解释成新年文案。清除仅作用于当前主题。

## 验证

质量检查仍为 `pnpm check`。新年浏览器验收使用相同的拖动、相机模拟和本机记录断言，显式选择新产物：

```sh
OFFLINE_THEME=new-year PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm exec playwright test --config playwright.offline.config.ts
```

也可运行 `pnpm test:offline:new-year` 自动先构建，再选择对应产物。当前源码的格式、lint、类型、资源校验、167 项测试、生产构建与包体预算均已通过；原始质量报告保留于本任务 `.artifacts/new-year-check.log`。

当前云环境的受管 Chromium 阻止 `file://` 导航，不能据此宣称文件直开通过。可按 [离线版说明](offline-demo.md) 启动仅回环的静态辅助服务，再加 `OFFLINE_TEST_BASE_URL=http://127.0.0.1:4183` 检查同一构建文件；主文档加载后断网，仍禁止任何业务 API/遥测调用或子资源请求。原版通过默认 `OFFLINE_THEME` 验证，两版同源数据隔离另作浏览器验证。

相机仅在点击并获得浏览器授权后开启；拒绝或能力不足仍可完整游玩。画面不上传或保存，不提供空间定位。模拟媒体与桌面/移动视口检查不替代真实镜头、Safari/微信真机或 `file://` 相机兼容性验收。

本轮 HTTP 辅助验收：新年版 40 项中 **38 通过、2 项文件专属场景跳过、0 失败**，涵盖原 14 项相机、8 项拖动、14 项玩法/恢复与新增 2 项双主题同源隔离；传输调用尝试、子资源请求和页面错误均为 0。原版另跑 12 项必要回归全部通过，其余 26 项本轮未重跑。

已实际查看桌面 1280×960、移动模拟 390×844 的首屏、游玩中、完成卡片六张截图，确认主题、文案、控件与布局，未见横向溢出。主要 CTA 与纸底对比度约 6.17:1，正文约 5.88:1。相机图仅为合成输入的外观证明。

报告保留于本任务 `.artifacts/offline-http-new-year-e2e-results.json`、`.artifacts/classic-theme-regression-results.json`；新年截图位于 `.artifacts/offline-http/new-year/`，另有根代理独立试玩的 `.artifacts/new-year-visual/`。这些是本任务允许的 HTTP 辅助验证，不是文件直开或真机验收。
