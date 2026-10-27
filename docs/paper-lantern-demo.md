# 把愿望放上天 · 新年纸灯

这是一个独立纸艺互动：写心愿、展开纸灯、挑选颜色和纹样、轻推虚拟放飞，再留下纪念卡。它不采用云朵收星或三站计分，原来的两份 HTML 继续保留，既有线上 Site 不变。

## 玩法

1. 选择预设或写一句心愿，最多 32 个 Unicode 码点；界面按统一规则计数，普通文字和 emoji 均可输入。
2. 按住有提示的红色提环向上拉开纸灯。进度单调保留，可以分多次操作；取消手势不会丢掉已展开部分。也可点击“展开纸灯”，或用键盘激活提环。
3. 选择朱砂红、暖杏或米白，搭配花开、窗花或涟漪三款原创纸艺纹样。
4. 准备好后向上轻推并松手，或点击“放飞心愿”。放飞只提交一次，取消或丢失指针捕获不会提前放飞。
5. 克制的飞行动画后生成心愿纪念卡，可重新制作。减少动态效果时仍可完整完成。

这是一盏屏幕里的虚拟纸灯，不是真实寄送或多人实时场景，没有真实燃放步骤、支付、奖品或录音。所有 SVG/CSS 图形均为原创并内嵌，无字体/CDN/图像下载。

## 相机与本机记录

普通模式完整可玩。“相机实景（可选）”默认收起，展开设置后仍须点击“开启相机实景”才申请视频权限，优先后置相机，不申请音频。纸灯仅在本机画面上叠加，不提供空间锚定。关闭设置、取消、完成、离开或隐藏页面时停止媒体轨道；迟到的授权结果也会释放。不拍照、不录制、不上传画面。

心愿通过 React 文本节点显示，不作为 HTML 执行、不放进 URL，也不调用业务 API 或遥测。只使用 `paper-lantern.offline.v1.draft` 与 `paper-lantern.offline.v1.cards`，不读取或清除云朵版的数据。最多保留最近 10 张卡，同 ID 幂等且内容冲突不会覆盖旧卡。

制作草稿可恢复；飞行中刷新会恢复到纪念卡，避免重复放飞。浏览器不允许存储或写入无法确认时明确退化到本次打开的内存，不冒称持久保存。分享 HTML 不携带浏览器历史；清除失败也会明确提示。

## 构建与验证

```sh
pnpm install --frozen-lockfile
pnpm build:offline:lantern
```

产物 `.artifacts/offline/paper-lantern-new-year.html`，元数据 `.artifacts/offline/paper-lantern-build.json`。原版与新春云朵 HTML 不会被覆盖，生成物不提交 Git。该入口复用 React、现有相机控制器与单文件构建检查，不增加依赖或服务。

```sh
pnpm check
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:offline:lantern
```

本任务系统 Chromium 的管理策略阻止 `file://`。默认测试保留文件直开路径，但本环境以显式回环 HTTP 辅助加载同一 HTML，随后断网；不修改策略或伪装成文件直开验证：

```sh
python3 -m http.server 4183 --bind 127.0.0.1 --directory .artifacts/offline
OFFLINE_TEST_BASE_URL=http://127.0.0.1:4183 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm exec playwright test --config playwright.lantern.config.ts
```

严格检查网络传输调用尝试、子资源请求和页面错误；手势用实际鼠标/触控，不强制点击。相机只用合成媒体，仍需实际设备、HTTPS 安全环境、Safari/微信及文件相机能力验证。测试与截图保留于本任务 `.artifacts/lantern-*`，不会把辅助模式或模拟媒体当成真机验收。
