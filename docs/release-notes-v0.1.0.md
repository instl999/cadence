# Cadence v0.1.0 发布说明 / Release Notes

发布日期 / Release date: 2026-08-19

## 简体中文

### 本版内容

- Windows 11 全局键盘输入响应，顶部按钮可明确启用或停用监听。
- 跟手模式：同步播放人声与伴奏分轨，输入活动控制人声显隐。
- 播放、暂停、下一首，以及顺序/随机播放。
- 固定的 `音乐资源/歌名/文件` 目录、自动扫描和变更刷新。
- Ultimate Vocal Remover 双轨识别与播放列表自动配对。
- 中英文用户指南、开发指南和资源目录导入说明。
- 公开发行包不包含开发者本地歌曲或测试分轨。

### 下载与使用

下载 `Cadence-0.1.0-Windows.exe`，并让它与 `音乐资源` 文件夹保持同级。若资源目录不存在，程序会在首次运行时自动创建示例结构。完整步骤见[中文用户指南](user-guide.zh-CN.md)。

### 隐私边界

全局监听只在用户点击“启用”后运行。原始键码只在 Electron 主进程中短暂分类，渲染层只接收 `char`、`back`、`enter`、`space` 四类事件；程序不保存或上传输入内容。暂停播放不等于停用监听，若要停止监听请点击“停用”或退出程序。

### 已知限制

- 当前仅以 64 位 Windows 11 为主要测试目标。
- 便携版尚未配置 Windows 代码签名，SmartScreen 可能显示提示。
- 应用不附带商业歌曲；用户必须自行加入拥有或获准使用的音乐。
- 项目暂未选择开源许可证，仓库默认以私有方式发布。

### 校验值

```text
文件：Cadence-0.1.0-Windows.exe
大小：94,315,490 字节
SHA-256：674B0A12B459A83AE7E64C8D0AE20FBC68DE401CDBAFE61B9524B264FAC0B1AF
```

## English

### Included in This Release

- Windows 11 system-wide keyboard response with an explicit Enable/Disable control.
- Typing-follow mode with synchronized vocal and instrumental stems.
- Play, pause, next, and sequence/shuffle controls.
- A fixed `音乐资源/song/files` directory with automatic scanning and refresh.
- Automatic pairing of Ultimate Vocal Remover outputs.
- Chinese and English user, development, and import documentation.
- No developer-local songs or test stems in the public package.

### Download and Use

Download `Cadence-0.1.0-Windows.exe` and keep it beside the `音乐资源` folder. Cadence creates the example structure on first run if the folder is missing. See the [English User Guide](user-guide.en.md) for complete instructions.

### Privacy Boundary

The global hook runs only after the user selects Enable. Raw key codes are classified briefly in the Electron main process, and the renderer receives only `char`, `back`, `enter`, or `space`. Typed content is not persisted or uploaded. Pause is not the same as Disable; select Disable or exit Cadence to stop monitoring.

### Known Limitations

- The primary tested target is 64-bit Windows 11.
- Windows code signing is not configured yet, so SmartScreen may display a warning.
- No commercial music is bundled; users must add music they own or are authorized to use.
- No open-source license has been selected yet, so the repository is private by default.

### Checksum

```text
File: Cadence-0.1.0-Windows.exe
Size: 94,315,490 bytes
SHA-256: 674B0A12B459A83AE7E64C8D0AE20FBC68DE401CDBAFE61B9524B264FAC0B1AF
```
