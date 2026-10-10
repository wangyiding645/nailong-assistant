<div align="center">

<img src="docs/screens/pet.png" width="160" alt="奶蛙助手">

# 奶蛙助手 · Nailong Assistant

**一只住在你桌面上的奶蛙。它有 pi 的大脑，你的电脑是它的手。**

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white)](#)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](#)
[![pi](https://img.shields.io/badge/内核-pi%201.1-6E56CF)](#-双内核pi-当大脑)
[![License](https://img.shields.io/badge/License-MIT-3DA639)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.3.1-orange)](CHANGELOG.md)

[简体中文](README.md) · [English](README_EN.md) · [架构](docs/ARCHITECTURE.md) · [安全](docs/SECURITY.md) · [更新日志](CHANGELOG.md)

</div>

---

## 下载 Windows 最新版

**3.3.1 · 2026-10-10 · Windows x64**

- [安装版](https://github.com/wangyiding645/nailong-assistant/releases/download/v3.3.1/nailong-assistant-3.3.1-win-x64.exe)：安装向导。
- [免安装版](https://github.com/wangyiding645/nailong-assistant/releases/download/v3.3.1/nailong-assistant-3.3.1-win-x64-portable.exe)：放到可写目录后直接运行，无需另装 Node.js 或 pi。
- [发布说明与校验文件](https://github.com/wangyiding645/nailong-assistant/releases/tag/v3.3.1)。

这一版：**数据不再被覆盖安装清掉**（安装版数据移到 `%APPDATA%\奶蛙助手`，卸载/覆盖都不丢，密钥与历史会话会随升级保留）；
工具调用**不再有次数上限**；历史会话点得开；桌宠气泡默认隐藏（悬停、提醒、计时才出现）。详见 [更新日志](CHANGELOG.md)。

安装包发布在本仓库的 Release。升级前退出旧版，并保留原程序旁的 `agent.json`、`settings.json`、`.userdata` 等个人数据；使用同一个 Windows 账户读取加密密钥。

## 🤖 双内核：pi 当大脑

奶蛙有 **54 个工具**，但"怎么想"这件事不必自己造：

| 内核 | 是什么 | 适合 |
| --- | --- | --- |
| **pi 内核**（默认） | 把 [pi](https://pi.dev) 当子进程跑（`pi --mode rpc`）。模型接入、上下文压缩、重试、thinking 档位、技能、会话树、多 provider 全交给它 | 想要最强的规划和长任务能力 |
| **内置引擎** | 原生的零依赖轻量 agent 循环：多协议流式、工具循环、权限确认 | 极简、不想多一个进程（模型调用仍需接口） |

```
你说话
  ↓
pi 子进程（--no-builtin-tools，只剩一颗脑子）
  ↓ 决定要动手
pi-ext/nailong.mjs（把奶蛙的 54 个工具注册成 pi 工具）
  ↓ 通过 127.0.0.1 的本地桥（随机 token）
Electron 主进程：截图 / 无障碍元素树 / 鼠标键盘 / 文件 / 系统 / 日程
  ↓ 每个动作都先问你（可以切自动）
真的动了你的电脑
```

- **换内核不放水**：两个引擎共用同一份权限实现。高危操作在哪个内核下都要确认
- **崩溃隔离**：pi 挂了桌宠照常蹦跶，界面自动退回内置引擎，不用重启应用
- **设置里一键切换**：`自动 / 只用 pi / 只用内置`

### pi 是自带的，不借你机器上那个

奶蛙给 pi 准备了一套**属于自己的配置目录**（`.userdata/pi-agent`），默认**完全不读** `~/.pi`：

| | 自带（默认） | 沿用系统（可选） |
| --- | --- | --- |
| 模型凭据 | 来自奶蛙设置（Base URL + Key + 模型） | 来自你在 pi 里的登录（订阅 / Key） |
| 代理 / 扩展 / 偏好 | 干净，不受影响 | 一并生效 |
| 身份说明 | 自动注入「你是桌面助手，不是写代码的编程助手」+ 红线 | 用 pi 自己的 |

为什么要自带：机器上 pi 的配置是别的工具留下的，会把奶蛙带坏。实测踩过一次 ——
`~/.pi/agent/settings.json` 里配了个没开的 `httpProxy`，所有模型请求都变成一句含糊的
`Connection error.`。现在除了隔离，还有一个**环境自检**会直接告诉你「哪个文件、哪个端口、
三条修复路径」，而不是让你对着一句英文发呆。

想用你已经在 pi 里登录好的模型？设置 → 模型 → 切成「沿用机器上 pi 的配置」即可。

### 界面上能用到 pi 的哪些能力

这些原本只有 pi 命令行里才有，现在都在助手窗里：

| 入口 | 做什么 |
| --- | --- |
| 🧠 模型 | 列出 pi 能用的全部模型（含你订阅登录的），点一下即切 |
| 💭 思考 | 推理档位 `off / minimal / low / medium / high / xhigh / max` |
| ⋯ → 压缩上下文 | 手动 compact，用量区会显示上下文占用百分比 |
| ⋯ → 复制当前会话 | 开分支；切会话时会真的回放历史（含工具调用、思考、截图） |
| ⋯ → pi 的命令与技能 | pi 发现的 slash 命令、prompt 模板、skills，点一下填入输入框 |
| ⋯ → 从某条消息重来 | 挑一条历史消息在那里开分支（fork），原对话保留 |
| 🗂 历史会话 → 会话结构 | 树状看整个会话，消息节点上点 ⑂ 就能从那里分支 |
| 运行中插话 | 它干活时发送键变成「插入」（steering），说的话进当前任务；也可选排在后面 |
| 拖图进对话框 | 把 png/jpg 直接拖进助手窗当附件发给模型（自动按长边缩放） |
| 🗂 历史会话 | 新建 / 切换 / 重命名 / 删除 |
| 设置 → 模型 | 配置目录模式（自带 / 沿用系统）、自动压缩、自动重试、默认档位、上下文窗口 |
| 设置 → 模型 | **计划模式**：动手前先把步骤列出来等你批准 |
| 设置 → 模型 | **MCP 服务器管理**：粘贴 Claude Desktop / Cursor 的 `mcpServers` 片段，带校验与增删启停 |
| 设置 → 模型 | **同时加载你自己的 pi 扩展**（MCP 服务器、子代理、code mode、第三方包）——默认关 |

关于最后一项：默认奶蛙只加载**自己**的扩展（`--no-extensions`），你的 MCP、子代理（pi-subagents）、
council 这类都不会进来，避免第三方代码在奶蛙旁边跑。要用就在设置里显式打开，
**代价写在界面上**：信任面会从「奶蛙自己的代码」扩到「你装过的所有 pi 包」。

另外设置 → 关于里还有**导出当前会话**为文本。

界面语言可在「设置 → 外观 → 语言」切换。词典中英各有 218 个 key，HTML 标记了 141 处翻译属性。测试校验已登记 key 的存在及中英集合一致；部分动态提示、设置说明仍为中文，不能据此声称全界面已完整翻译。

### 它到底能干什么

不是"陪聊"，是真的动你的电脑：

| 你说 | 它做 |
| --- | --- |
| 「看看我屏幕上有什么」 | 截屏 + 读无障碍元素树，报出前台窗口和里面的控件 |
| 「把微信里未读消息数报给我」 | 自己找窗口、看界面、数给你听 |
| 「明天下午3点半跟设计组评审 #工作」 | 解析成日程写进日历，提前 10 分钟提醒你 |
| 「把桌面上的截图都收进一个文件夹」 | 列目录、建文件夹、移动文件 |
| 「我最近两周效率怎么样」 | 读自己的打卡和番茄记录，给你统计 |
| 「记住我的项目文档在 D:\work\docs」 | 写进长期记忆，以后所有对话都知道 |
| 「25 分钟后叫我」 | 起番茄钟，到点奶蛙跳起来叫你 |

### 工具清单（54 个）

| 组 | 能力 |
| --- | --- |
| 🖥 **电脑操作**（19） | `screenshot`（可指定显示器） `view_image`（看本地图片） `ui_tree` `find_element` `click_element` `click` `dblclick` `rightclick` `drag` `type_text` `press_key` `scroll` `move_mouse` `launch` `focus_window` `window_action` `screen_info` `wait` |
| 📁 **文件**（9） | `read_file` `write_file` `list_dir` `file_info` `mkdir` `copy_path` `move_path` `delete_path`（进回收站） `search_files` |
| ⚙️ **系统**（11） | `run_command` `clipboard_get/set/history` `system_info` `list_processes` `set_volume` `set_brightness` `lock_screen` `notify_user` `web_fetch` |
| 📅 **日程**（6） | `schedule_list/add/done/remove` `countdown_list/add` |
| 🍅 **专注**（4） | `focus_start/status/stop` `stats_overview` |
| 🧠 **记忆**（2） | `remember` `recall` |
| 🐸 **助手**（2） | `ask_user` `think` |

**为什么比"纯截图"的方案准**：`native/uia.ps1` 常驻一个 Windows UI Automation worker，
把控件以「角色 + 名称 + 精确边界 + 是否可用」的带 id 文本吐出来。模型说
`click_element("e37")`，而不是猜像素坐标 —— 猜坐标是同类工具翻车最多的地方。

---

## 🍅 顺便，它是一套完整的时间管理工具

这些不需要任何 API Key，装上就能用。

### 日程与提醒
- 支持重复规则：`每天 / 工作日 / 每周末 / 每周一三五 / 每月1号 / 每年 / 每2天`
- **说人话就能加**：「明天下午3点半跟设计组评审 #工作 提前10分钟」→ 自动解析出日期、时间、重复、标签、提醒
- 提前提醒分钟数可配、稍后提醒（snooze 10 分钟）、启动时补报错过的提醒、每日小结
- 到点：桌宠气泡变红闪烁 + 跳跃 + 提示音 + Windows 系统通知

### 番茄钟与统计
- 专注 / 短休 / 长休，自动衔接，可暂停跳过，每天目标
- 连签天数、21 天热力图、按标签完成率、最出活的时段
- AI 用量账本（几次调用、多少 token、花了多少钱）

### 更多
- 🗂 剪贴板历史（本地、可搜、可关）
- ⏳ 倒计时 / ⏰ 闹钟 / 🪙 抛硬币 / 🏃 抓奶蛙
- 🗑 拖文件到奶蛙身上 → 它跑过去问你 → 确认后进回收站（**吃下去还会长 10%**，设置 → 外观有 50%–999% 的体型滑杆）
- 🔊 托盘常驻、全局快捷键、开机自启

### 数据全在本地
`schedule.txt`、`countdown.txt`、`settings.json` …… 全是可读的纯文本 / JSON，
可以直接手改、可以 git、可以一键导出导入（导入前会自动备份当前数据）。
密钥用 Windows DPAPI 加密，界面里永远显示 `••••••`。

---

## 🎨 界面

Apple Liquid Glass 风格：真实壁纸模糊采样 + 左上高光 + 1px 边缘折射 + 同心圆角。
六套主题（奶黄 / 浅色 / 琥珀 / 科技青 / 午夜紫 / 深空灰），桌宠、面板、助手、工具、设置全部统一。

<p align="center"><img src="docs/screens/panel.png" width="300" alt="日程面板"> <img src="docs/screens/tool.png" width="300" alt="工具面板"></p>

---

## 🚀 快速开始

### 方式一：下载即用（推荐）

到 [**Releases**](../../releases) 或 `dist/` 里拿一个：

| 文件 | 怎么用 |
| --- | --- |
| `nailong-assistant-3.3.1-win-x64-portable.exe`（133MB） | **免安装**：双击就跑。你的数据（日程、设置、对话记录）会存在**这个 exe 旁边**，整个文件夹拷走就是完整搬庄 |
| `nailong-assistant-3.3.1-win-x64.exe`（133MB） | 安装向导：自动建快捷方式，卸载时**不会删你的数据** |

两个都是自带 pi 内核的完整版，不需要你先装 pi、也不需要 Node。
第一次运行会在旁边生成 `schedule.txt` / `settings.json` / `.userdata/`，都是可直接手改的纯文本。

### 方式二：从源码运行

```bash
git clone https://github.com/wangyiding645/nailong-assistant.git
cd nailong-assistant
npm install
npm start
```

环境：Windows 10/11 + Node.js 18+。

### 三步用起来

1. 双击 exe（桌宠就蹲在桌面右下角了），右键奶蛙 → **⚙ 设置**
2. 在「模型接口」里填 **Base URL + API Key**（模型可留空自动检测）—— 这一步只需要做一次
3. 右键奶蛙 → **🤖 奶蛙助手**，开口使唤：「看看我屏幕上有什么」

> **只想用日程 / 番茄钟 / 提醒 / 桌宠小游戏？完全不用配 Key**，双击就能用。
> 奶蛙检测到没配接口会自动用内置引擎，并在设置里告诉你去哪填。

---

## ✅ 质量

```bash
npm run check     # 语法自检 + 92 个测试
npm run audit     # 无头界面自检：六窗口 × 六主题 × 十八分页 × 七形态
npm run smoke:pi  # 真起一次自带 pi 内核，验证 54 个工具注册（给了接口配置就真发一句）
npm run dist      # 打出 portable + 安装包
```

- **92 个测试**：纯逻辑、重复规则、中文自然语言解析、番茄钟状态机、统计、工具、
  权限分级、危险命令拦截、多协议适配、事件归一、工具桥鉴权、音频素材合法性、
  会话历史转录、自带 agent 目录的幂等与隔离，以及**真起一个 pi 子进程**验证扩展把 54 个工具注册进去
- **界面自检**只在“元素真的被裁掉”时才报错：会先找最近的 `overflow` 祖先，可滚动的跳过
- 启动和打开助手播放用户提供的安迪音频；提醒、计时和互动继续使用原版大笑 `laugh.wav`。重复播放不叠加，关声音会立即停止。播放失败时保持安静，Windows 通知静音。
- 界面使用稳定的奶油白、云雾白和柔和深色底，不再采样壁纸作为背景。密钥保存成功后可在同一 Windows 账户和数据目录中重启读取；失败会明确报错。
- 所有 HTML 带 CSP，渲染层零 Node 权限

---

## 📁 项目结构

```
main.js                  入口：装配 + 形态切换 + 定时循环
preload.js               contextBridge（渲染层唯一通道）
pi-ext/nailong.mjs       pi 扩展：注册工具 + 注册 provider
renderer/                6 个窗口 + ui.css（Liquid Glass 设计系统）
src/shared/              纯逻辑：日期、任务、重复规则、自然语言、番茄钟、统计
src/main/                主进程：store / log / services / windows / host / native / shell / ipc
  engines/               ★ 双内核：bridge（本地工具桥）/ pi（RPC 引擎）/ index（路由）/ pi-history
  agent/                 内置引擎：多协议适配、工具循环、权限、用量、记忆、提示词
  tools/                 54 个工具（两个内核共用同一份定义）
native/                  PowerShell：输入模拟 / UI Automation / 窗口 / 系统 / 回收站 / 毛玻璃
test/                    node:test
scripts/                 语法自检、界面自检
```

细节见 [架构文档](docs/ARCHITECTURE.md)。

---

## ⚠️ 免责声明

- 奶蛙会**真的操作你的鼠标键盘**。第一次用请留在「每步确认」模式，避免让它处理付款、删除等重要操作
- 拖拽回收走系统回收站（可还原），仍请确认后再点「回收」
- 截图会发给你配置的模型服务商 —— 这是设计使然，介意就别用视觉相关的工具
- 本项目与任何模型服务商无关联，接口费用由你的账号承担
- pi 内核由 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 提供（MIT），
  其余代码为本项目原创

## 🙏 致谢

- [pi](https://pi.dev) —— 提供内核
- 角色动画 / 音效素材来自奶蛙（nailong）素材库；如你是原作者并希望调整署名或许可，请开 Issue
- 灵感来自各类桌面宠物、Tamagotchi 与 "computer use" 智能体

## 📄 License

[MIT](LICENSE) © 2026 wangyiding645

<div align="center"><sub>如果这只小奶蛙真的帮你干了活，点个 ⭐ 就是最大的鼓励</sub></div>


本次审查及修复记录：[最终审查与验收报告](docs/最终审查与验收报告-20261010.md)。界面自检检查 36 个窗口/主题组合、23 个独立操作步骤、6 个英语标签页面和7个模式状态，并不代表这些维度的全部组合或真实模型验收。
