# Cadence

让键盘输入成为音乐。Cadence 是一款面向 Windows 11 的本地桌面应用：启用后，它会在你使用任意应用打字时读取**击键时机和结构类别**，用输入节奏控制歌曲分离音轨的显隐。

Turn typing into music. Cadence is a local Windows 11 desktop app that responds to keyboard activity across applications and uses the timing of your input to reveal separated music stems.

[中文用户指南](docs/user-guide.zh-CN.md) · [English User Guide](docs/user-guide.en.md) · [中文开发指南](docs/development.zh-CN.md) · [Development Guide](docs/development.en.md) · [v0.1.0 发布说明 / Release Notes](docs/release-notes-v0.1.0.md)

## 使用前重点 / Before You Start

- 只有点击“启用”后才开始 Windows 全局键盘监听；点击“停用”或退出应用后停止。
- 程序不保存输入内容。原始键码只在 Electron 主进程中短暂分类，音乐界面只收到 `char`、`back`、`enter`、`space`。
- 暂停音乐**不等于**停用监听。若要停止监听，请点击“停用”或退出 Cadence。
- 用户音乐在本机读取，不会上传；采样钢琴首次初始化时可能通过 `smplr` 使用的 CDN 下载音色，离线时会回退到本地合成器。
- 当前便携版未配置代码签名。只运行可信来源的构建，并核对发布方提供的 SHA-256。

---

- Windows-wide monitoring starts only after **Enable** and stops on **Disable** or app exit.
- Typed content is not saved. Raw key codes are briefly classified in the Electron main process; the renderer receives only `char`, `back`, `enter`, or `space`.
- Pausing playback does **not** disable monitoring. Use **Disable** or exit Cadence to stop it.
- Imported music stays local. The sampled piano may make a one-time CDN request through `smplr`; offline use falls back to a local synthesizer.
- The current portable build is unsigned. Run only trusted builds and verify the publisher's SHA-256 checksum.

## 快速目录 / Quick Layout

```text
Cadence-0.1.0-Windows.exe
音乐资源/
└─ 示例歌曲/
   ├─ 示例歌曲_(Vocals).wav
   └─ 示例歌曲_(Instrumental).wav
```

完整安装、UVR 分离、导入、权限、排错、更新和卸载说明见上方用户指南；架构、测试与发布流程见开发指南。

See the user guides above for installation, UVR separation, importing, privacy, troubleshooting, updates, and removal. Architecture, testing, and release details are in the development guides.

> 许可提示 / License note：本仓库目前没有项目级 `LICENSE` 文件。正式公开分发或接受外部贡献前，应由项目所有者选择并加入合适的许可证。The repository currently has no project-level `LICENSE`; choose one before public redistribution or accepting contributions.

## 中文项目说明

用你的打字节奏，弹他们的音符。

一个写作板，背景放古典钢琴。音乐不是随机生成的 —— 每个音符都来自真实的乐谱，
你的打字节奏只决定**什么时候响、响多少、多重**。

## 架构：同步分轨 + 音量门

所有声部**共用一条播放时间轴，永远同步向前走**。击键不启动任何采样，
只控制各声部的音量门。

```
最终声音 = 背景声部 × 背景系数(随前景下降)
         + 前景声部 × 打字活动值
         + 极轻的击键触感音
```

这是整个设计里最关键的一点。**不要让每个按键去启动一个人声采样** ——
那会变成「我…我…我…不…不…不…」的口吃。让人声轨一直在后台同步播放、
键盘只控制音量门，用户听到的就永远是原曲在那一刻本来的样子。

于是用户虽然没真的弹准任何音符，却会产生很强的错觉：
「是我把这一段唱出来的」「我一停，歌就退回伴奏了」。

同步靠的是所有轨用同一个 `ctx.currentTime` 起播、同一个 offset —— 实测
3 秒内时钟误差 **0ms**，两轨缓冲时长精确到小数点后 10 位一致。

### 两层反馈

| 层 | 内容 | 时机 |
|---|---|---|
| **触感层** | 20~60ms 的极轻瞬态（−26dB） | **每一次**击键 |
| **音乐层** | 声部音量门 | 按窗口**合并**多次击键 |

音乐层不响应每个按键，否则高速打字会变成机关枪。触感层保证「我每按一下都有反应」。
空格/回车额外触发一次更明显的重音（词/段落边界）。

### 打字速度控制「显现时长」，不控制「轨道数量」

越打越快不是加更多乐器，而是让当前声部保持打开更久，直到接近原曲完整混音**然后封顶**。
实测（示例人声轨）：

| 打字速度 | 人声增益范围 | 接近静音占比 | 听感 |
|---|---|---|---|
| 5.3 键/秒 | 0.54 – 1.0 | 0% | 连续，接近完整混音 |
| 3.3 键/秒 | 0.29 – 1.0 | 0% | 连续但有呼吸起伏 |
| 1.5 键/秒 | 0 – 1.0 | **42%** | 断续、轻柔 |

- 单键：75ms 达峰
- 停手：375ms 淡出（含「让当前字音结束」的保持窗口），不是瞬断
- 前景全开时背景降到 0.64（**−2.5dB**），总响度基本不变
- 同时开放的前景声部上限 **2 个**

> 一个调错过的地方：显现窗口不能随投入度长到 0.78 秒。连续打字时击键间隔
> 本来就短于窗口，靠不着加长来维持连续；窗口一长，停手后还得先熬完窗口
> 才开始淡出，实测总延迟 >900ms，像卡住。加长只在中速区间有用，幅度要小。

### 演奏模式

| 模式 | 背景 | 打字打开 |
|---|---|---|
| **人声演奏** | 伴奏 / 鼓 / 贝斯 | 原唱 |
| **乐器演奏** | 人声 / 鼓 / 贝斯 | 旋律乐器 |
| **鼓组演奏** | 人声 / 伴奏 / 贝斯 | 鼓 |

界面只显示当前分轨集合支持的模式。两轨分离（人声+伴奏）只有「人声演奏」。

**间奏段自动正确**：那里人声轨本来就是空的，开门也不会有声音 —— 不需要任何
静音检测代码。触感层仍在响应，所以不会觉得应用死了。

## 隐私

**只采集击键时间戳，不记录按了哪个键。** 见 `src/engine/typing-sensor.js` ——
对外只发出 `{ t, kind }`，kind 仅四类（普通字符 / 退格 / 回车 / 空格），
任何字符和 keyCode 都不会离开那个函数。输入分析和用户音乐都在本机完成，用户内容不会上传。

这既是隐私设计，也是音乐上的正确选择：字母本身没有音乐意义。

（采样钢琴音色首次加载时会从 CDN 取样本；离线会自动回退到内置合成音源。）

Windows 桌面版使用全局键盘钩子，但**只有点“启用”后才安装监听，点“停用”立即卸载**。
原始 keyCode 和修饰键状态只存在于 Electron 主进程；页面仍然只收到
`{ kind: char | back | enter | space }`，不会得到具体字符。

## 放你自己的音乐

普通用户请使用上面的固定 `音乐资源/歌名/文件` 结构。以下 `local-*` 目录仅用于源码开发和构建测试；三种素材的能力从强到弱，**分离音轨是完全体**。

Windows 桌面版会自动扫描 `Cadence.exe` 同级的固定资源目录，文件变化后自动刷新：

```
音乐资源/
  示例歌曲/
    示例歌曲_(Vocals).wav
    示例歌曲_(Instrumental).wav
```

播放列表右侧的 **音乐资源** 按钮会直接打开这个目录；每首歌必须有自己的歌名文件夹。
普通 MP3 也能播放，UVR 输出的人声/伴奏双轨会自动配对并启用完整跟手效果。

### 一、分离音轨（推荐）

用 [Ultimate Vocal Remover](https://ultimatevocalremover.com/) 把原曲分离，
然后按歌名建文件夹丢进去：

```
local-stems/
  Example Song/
    Example Song_(Vocals).mp3         <- 人声：同步播放，音量由击键控制
    Example Song_(Instrumental).mp3   <- 伴奏：常开，永不中断
```

**文件名按关键词识别角色**，UVR 的 `Song_(Vocals).mp3` 和
Demucs 的 `vocals.wav` / `drums.wav` / `bass.wav` / `other.wav` 都认。
中文的「人声」「伴奏」也认。

Demucs 四轨（vocals / drums / bass / other）也支持，模式会更多。
**四轨约 360MB 内存，两轨约 180MB**（248 秒立体声），载入时会显示实际占用。

分离交给 UVR 是对的分工——MDX-Net / Demucs 的效果比浏览器里能做的任何东西都好，
而且是一次性离线处理，不占运行时。程序只负责切片和对齐。

**间奏怎么办**：人声轨在前奏/间奏是空的，那几十秒里击键会自动落到兜底层
（同名 MIDI 的旋律，或从伴奏轨估调性后的五声音阶），不会突然哑掉。

**同名 MIDI 会一并挂上**（`local-midi/Example Song.mid`），作为兜底层的素材。

### 二、原曲音频 + 配套 MIDI

```
local-audio/Example Song.mp3
local-midi/Example Song.mid    -> 击键弹出原曲真正的旋律音（钢琴音色）
```

对不齐就用侧栏的 **MIDI 对齐偏移** 滑块校准（±2 秒）。

### 三、只有音频 / 只有 MIDI

只有音频 → 估调性 + 五声音阶。只有 MIDI → 骨架时钟播放、装饰音击键释放。

---

放完跑一次 `npm run midi` 重建清单。`local-*` 三个目录都在 `.gitignore` 里，
不进版本库、不参与分发。

### 灵敏度（另一个滑块）

打字状态影响伴奏织体/力度/速度的幅度。0 = 纯背景音乐，音乐完全不理你。

### 哪里找正规的公有领域 MIDI

- **Mutopia Project** — 明确的自由许可，从 LilyPond 乐谱生成
- **IMSLP** — 乐谱为主，部分条目附 MIDI
- **piano-midi.de** — 人工演奏录制，质量高

注意版权的一个坑：**作曲**进入公有领域（肖邦 1849 年去世），不代表某个具体的
**演奏录音或 MIDI 转录**没有版权。商用前单独确认。

## 开发

```bash
npm install
npm run dev          # 浏览器预览（只响应当前页面）
npm run desktop      # 构建并启动 Windows 桌面版
npm run package:win  # 生成 release/Cadence-*-Windows.exe
```

`npm run midi` 会从 `scripts/scores/*.mjs` 的转录数据重新生成 `public/midi/` 里的
标准 MIDI 文件。内置曲目和用户导入的文件走完全相同的解析管线，没有特例。

## 桌面结构

- `electron/main.cjs`：Windows 全局键盘监听，只负责把按键归为四种结构类别。
- `electron/preload.cjs`：上下文隔离的最小 IPC 桥，不向页面暴露 Node 或原始事件。
- `src/main.js`：跟手音乐、启用状态、播放队列和界面。

网页预览仍然保留，便于快速调 UI；真正的跨应用输入只在 Electron 桌面版中启用。
