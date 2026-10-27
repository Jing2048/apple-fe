# 云朵邮局：单文件离线演示

离线版复用原有 React 画面、SVG、动画、三站六星互动与三张祝福卡，全部脚本和样式嵌入一个 HTML 文件。它不调用 API、不采集或上传事件、不依赖字体/CDN/服务器，也不改变已上线站点。

## 构建与打开

需要与原工程相同的 Node.js 24、pnpm 11.25.0 和已安装的锁定依赖。联网安装依赖只发生在构建阶段；交付的 HTML 运行时不需要网络。

```sh
pnpm install --frozen-lockfile
pnpm build:offline
```

产物为 `.artifacts/offline/cloud-post-offline.html`，大小与 SHA-256 写入同目录 `build.json`。生成文件不提交 Git。复制这一份 HTML 后，用支持 JavaScript 的现代浏览器直接打开 `file://`，不需要运行开发服务器。聊天软件、邮件客户端或文件应用的内置预览可能不会执行脚本，需要选择在浏览器中打开。

打包沿用现有 Vite/React 工具链，输出一个经典 IIFE 脚本，不含模块请求、动态分包或外部资源。构建检查限制为单脚本与内联 CSS，总文件不超过 512 KiB，并拒绝外部样式资源。HTML 的 CSP 禁止网络连接、外部脚本、表单和 iframe。

## 玩法与本机记录

页面始终标注“离线演示”。点击开始，拖动、触控轻点或键盘收集三组六颗星光，完成后可切换三张祝福卡、重新寄一封。暂停、后台恢复、刷新时的草稿恢复与减少动态效果沿用现有玩法。

完成记录最多保留最近 20 封；同一回合重复恢复或切换卡片不会新增记录，也不改变首次记录时间。点击“查看本机记录”查看本地列表，“清除本机记录”清空离线记录和旧草稿并重新开始。清除操作不触碰在线版草稿或其他存储键。

浏览器允许时使用 `localStorage` 的独立命名空间：

- `cloud-post.offline.v1.records`：本机完成记录，含版本、随机本地 ID、回合 ID、卡片序号和时间。
- `cloud-post.offline.v1.draft`：当前旅程与卡片草稿。

记录只属于当前浏览器对该文件的本地存储，不会写回 HTML 文件。分享、重命名或移动文件不保证带走历史；不同浏览器对 `file://` 存储的支持与作用域不同。

存储被拒绝、额度不足或写入无法确认时，完成记录退化为本次打开的内存，并明确提示刷新/关闭后可能丢失。只有成功写入且读回确认后才标记为本机持久记录。无法确认删除时也会提示，而不承诺磁盘记录已清除。

离线列表不是服务端回执，也不能证明数据库入库、埋点接收或外部业务接入。页面不展示数据库核验入口；线上完整链路另见 [Sites 部署记录](sites-adaptation.md)。

## 自动化验收

```sh
pnpm test:offline
# 本任务云环境使用已安装的系统 Chromium：
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:offline
```

离线 Playwright 配置不启动任何服务器，直接打开构建的 `file://` 文件。测试在断网状态验证完整玩法、卡片选择、重复游玩、刷新、记录/清除、移动视口、键盘与存储不可用的退化；同时检查脚本的网络调用尝试和非主文档资源请求。浏览器结果保存在 `.artifacts/offline-e2e-results.json`，实际画面位于 `.artifacts/offline/`。

持久化边界测试属于原前端测试集，运行 `pnpm --filter @apple/web test`；全工程质量检查仍为 `pnpm check`。Chromium 桌面与移动模拟不等于 Safari、微信、iOS 文件预览或真实手机验收。

## 本任务实际验证与限制

`pnpm check` 已通过：共 141 项单元/API/SQL 测试（含新增 14 项本机记录测试），以及格式、lint、类型检查、资源检查、构建与包体预算。

系统 Chromium 直接导航 `file:///workspace/apple-fe/.artifacts/offline/cloud-post-offline.html` 实际返回 `ERR_BLOCKED_BY_ADMINISTRATOR`。只读检查确认 `/etc/chromium/policies/managed/urls.json` 的管理策略不允许 `file://`；没有修改策略、禁用安全标志或绕过。因此本环境的文件直开和搬移文件测试尚未通过，需要在允许本地 HTML 的浏览器执行默认测试。

辅助检查使用同一 HTML 经允许的回环静态 HTTP 加载，加载后让浏览器断网；桌面 1280×960 与移动模拟 390×844 均完成六星、卡片选择和本机记录，JavaScript 错误及子资源请求均为 0，无横向溢出。这只验证断网游玩，不替代 `file://` 的导航与存储兼容性。辅助静态服务不是应用依赖，也不运行 API。

受管环境可显式重跑辅助模式；以下静态服务和测试分别在两个终端执行，默认文件直开测试不受影响：

```sh
python3 -m http.server 4183 --bind 127.0.0.1 --directory .artifacts/offline
OFFLINE_TEST_BASE_URL=http://127.0.0.1:4183 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm exec playwright test --config playwright.offline.config.ts
```

辅助报告独立保存在 `.artifacts/offline-http-e2e-results.json`，截图位于 `.artifacts/offline-http/`。HTTP 模式明确跳过文件搬移测试，不将其计为文件验收通过。

本轮辅助模式结果为 **14 通过、2 跳过、0 失败**，耗时 22.7 秒；已跑场景的网络传输调用尝试、子资源请求和页面错误均为 0。包括重复游玩、刷新恢复、卡片选择、本机记录与清除、存储全拒绝、删除失败后不恢复旧回合，以及键盘/触控操作。两项跳过均为桌面/移动的文件搬移专属场景，受上述管理策略限制。
