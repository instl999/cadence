# Cadence 开发与发布指南（简体中文）

[返回首页](../README.md) · [English](development.en.md) · [用户指南](user-guide.zh-CN.md)

## 1. 技术栈与环境

- Electron 43、Vite 7、原生 JavaScript / HTML / CSS
- Tone.js、smplr、`@tonejs/midi`
- `uiohook-napi`（Windows 全局键盘事件）
- electron-builder（Windows 便携版）

建议使用 64 位 Windows 11。Node.js 版本需满足当前 Vite 依赖要求；以锁文件为准，推荐 Node.js 22.12 或更高版本。依赖变更必须同步提交 `package-lock.json`。

## 2. 安装与命令

```powershell
npm install
npm run midi
npm run dev
npm run build
npm run desktop
npm run package:win
```

| 命令 | 说明 |
|---|---|
| `npm run midi` | 生成 `public/midi/manifest.json` 和内置 MIDI 资源 |
| `npm run dev` | 启动 Vite 浏览器预览；只监听当前页面键盘事件 |
| `npm run build` | 生成 `dist/` |
| `npm run desktop` | 构建并启动 Electron 桌面版 |
| `npm run package:win` | 使用 `--no-local` 排除本地歌曲，构建便携 `.exe`，再合并示例资源和文档 |

浏览器预览适合快速调 UI，但不能验证系统级键盘监听、外部资源目录、自定义媒体协议或资源管理器按钮。这些功能必须在 Electron 桌面版中验证。

## 3. 目录结构

```text
electron/
  main.cjs            Electron 生命周期、全局钩子、资源扫描与 IPC
  preload.cjs         contextBridge 最小接口
scripts/
  build-midi.mjs      构建 MIDI 清单
  prepare-release.mjs 合并发布版音乐资源示例
src/
  main.js             UI 状态、播放控制和音乐引擎编排
  styles.css          界面样式
  library/library.js  本地音乐归组、分轨识别和缓存
  engine/             播放、门控、分析和输入节奏逻辑
音乐资源/
  歌曲名示例/         随发布版复制的用户示例
public/midi/           由构建脚本生成或维护的内置资源
docs/                  中英文说明
```

以下目录不应提交：

```text
node_modules/ dist/ release/
local-midi/ local-audio/ local-stems/
public/midi/local/ public/midi/audio/ public/midi/stems/
```

这些目录可能包含大体积文件、构建产物或用户有版权的音乐。`音乐资源` 中除 `歌曲名示例` 外的内容也默认忽略。提交前仍要使用 `git status` 和暂存区差异确认范围。

## 4. 运行时架构

### Electron 主进程

`electron/main.cjs` 负责：

- 单实例锁与窗口生命周期。
- 加载 `uiohook-napi`，在用户明确启用时启动全局钩子。
- 把原始键码归为 `char`、`back`、`enter`、`space`。
- 确保可执行文件旁的 `音乐资源` 存在。
- 扫描“一级歌名文件夹 + 文件”的固定结构。
- 通过 `fs.watch` 监听资源变化并防抖刷新。
- 使用哈希令牌注册 `cadence-media://` URL，避免把真实绝对路径暴露给渲染层。
- 通过 Electron `shell.openPath` 打开资源目录。

### Preload 安全边界

`electron/preload.cjs` 在 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 条件下暴露最小接口。所有输入类别都经过白名单校验；渲染层无法直接调用 Node.js，也拿不到原始键码。

### 渲染层与音乐库

`src/main.js` 负责启用状态、加载状态、播放器按钮、顺序/随机逻辑、播放列表、拖放和 UI 更新。桌面端输入来自 preload；浏览器预览仅使用当前页面的 `keydown`。

`src/library/library.js` 将内置 MIDI、普通音频、用户文件夹、拖放文件和桌面资源归一成播放条目。分轨按目录与清理后的歌名聚合，优先形成 `vocals + instrumental` 的跟手条目。

## 5. 输入隐私数据流

```text
Windows keydown
  -> uiohook-napi（主进程收到原始事件）
  -> keyKind()（立即分类）
  -> IPC 仅发送 { kind }
  -> TypingSensor 记录时间戳和类别
  -> 音量门与触感反馈
```

关键约束：

- 不把 `event.keycode` 或修饰键状态传给渲染层。
- 不记录字符，不重建文本，不持久化输入事件。
- “启用”启动钩子，“停用”和退出停止钩子。
- 暂停播放器不会自动停用钩子，这是有意区分的两个状态；UI 和文档必须持续说明这一点。

任何更改这一边界的功能都应视为安全与隐私敏感变更，必须单独审查。

## 6. 音乐资源契约

### 根目录解析

- 开发模式：项目根目录下的 `音乐资源`。
- Windows 便携版：`PORTABLE_EXECUTABLE_DIR/音乐资源`。
- 其他打包形态：`process.execPath` 所在目录下的 `音乐资源`。
- 测试可通过 `CADENCE_MUSIC_ROOT` 指定隔离目录。

### 扫描与安全规则

- 只扫描 `音乐资源` 的直接子目录；每个直接子目录视为一首歌的容器。
- 只读取白名单扩展名。
- 真实路径不会通过 IPC 返回；主进程生成哈希令牌和 `cadence-media://file/<token>`。
- 协议处理器再次验证文件仍位于资源根目录内，防止路径越界。

### 分轨识别

`library.js` 先移除扩展名并规范化名称，再用角色关键词识别。`Vocals` 与 `Instrumental` 成对时创建完整分轨条目；不完整分轨回退为普通音频。新增关键词时应同时检查带括号的 UVR 命名和 Demucs 的纯角色文件名，避免 `instrumental` 被 `vocal` 子串误判。

## 7. 播放模型

核心不是逐键启动采样，而是“同步分轨 + 输入音量门”：

```text
最终声音 = 背景声部 × 背景系数
         + 前景声部 × 输入活动值
         + 轻微的击键触感音
```

所有分轨共享 AudioContext 时间轴、起始时间和 offset。逐键只更新活动模型与触感层；声部增益平滑变化，避免高速打字把人声切成重复碎片。

输入传感器只保留时间戳与四类事件，并计算速率、间隔变异、退格率和段落边界等音乐特征。空格/回车会触发略强的触感音，但不会泄露具体文本。

## 8. 构建与发布

```powershell
npm ci
npm run build
npm run package:win
```

主要输出：

```text
release/
  Cadence-<version>-Windows.exe
  音乐资源/
    歌曲名示例/
```

发布构建先用 `scripts/build-midi.mjs --no-local` 删除 `public/midi` 下的本地媒体**生成副本**，不会触碰 `local-*` 原始文件。`scripts/prepare-release.mjs` 随后复制资源示例和双语文档。它使用合并复制，不会主动删除已经放在发布目录中的歌曲，因此公开构建前仍应使用干净的 `release/`，避免把旧测试音乐误发出去。

当前 `.exe` 未配置 Windows 代码签名。正式公开发布前建议：

1. 配置可信代码签名证书。
2. 为二进制生成 SHA-256 并与发布说明一起公布。
3. 把源码推送到 GitHub，但不要把 `release/` 或用户音乐提交到 Git 历史。
4. 将 `.exe` 作为 GitHub Release 资产上传；它可能超过普通 Git blob 的大小限制。
5. 在公开仓库前选择并加入明确的 `LICENSE`。

## 9. 验证清单

### 静态与构建

```powershell
node --check electron/main.cjs
node --check electron/preload.cjs
node --check src/main.js
node --check src/library/library.js
npm run build
```

### 桌面冒烟测试

- 最终便携版能启动，且只出现一个实例。
- 点击“音乐资源”打开的是 `.exe` 同级目录。
- 示例目录存在，帮助 `?` 能完整显示。
- 放入真实 UVR 双轨后，播放列表自动刷新并显示一个分轨条目。
- 该条目能够解码、播放、暂停和下一首。
- 启用后，在另一个普通权限应用中输入可以驱动音乐。
- 停用后输入不再驱动音乐；退出后没有残留 Cadence 进程。
- 顺序/随机模式、播放列表点击和离线合成器回退正常。

### 安全回归

- IPC 仍只传递合法的 `kind`。
- 自定义媒体协议不能读取 `音乐资源` 之外的路径。
- 外部导航和新窗口仍被禁止。
- 渲染层仍保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。

## 10. 常见开发问题

### `uiohook-napi` 加载失败

确认 Node/Electron 架构和依赖锁定一致。项目通过 `asarUnpack` 解包该原生模块，并在 `package.json` 中固定版本。升级 Electron 或原生模块后必须在打包产物上重新验证。

### 浏览器预览正常，桌面版无声音

浏览器和 Electron 的 `file://`、自定义协议及音频权限路径不同。使用 `npm run desktop` 检查，并确认 `vite.config.js` 保持相对 `base: './'`。

### 构建中意外出现本地歌曲

`npm run midi` 会读取 `local-midi`、`local-audio` 和 `local-stems`，用于开发预览。公开打包应始终使用 `npm run package:win`，它会调用 `--no-local` 并清除 `public/midi` 下的生成副本；不要直接把普通 `npm run build` 的产物当作公开发行版。

## 11. 许可与第三方组件

仓库目前没有项目级 `LICENSE` 文件，不能默认视为任何开源许可。发布者应选择许可证，并核对 Electron、Tone.js、smplr、uiohook、UVR 模型以及随附素材各自的许可和署名要求。歌曲录音、MIDI 转录与分离音轨的授权需要单独确认。
