<div align="center">

# 大肥鱼 🐋

**陪你写代码的桌面 Agent 伴侣，Claude Code 和 DeepSeek Harness 共用一只。**

[English](README_EN.md) · [更新日志](CHANGELOG.md) · [授权说明](ASSET_LICENSE.md)

</div>

大肥鱼是一只透明、无边框、始终置顶的桌面角色。你在编辑器、浏览器里干活时，它会实时显示 Agent 在做什么：思考、查找、修改、执行、等待确认、完成、出错。

本项目最初基于 [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) 改写，在原来只支持 DeepSeek Harness（DSH）的基础上，增加了 Claude Code 支持、多产品同时监听、碎碎念、换形象等功能，致谢见文末。

<img src="docs/images/balance-preview.png" width="460" alt="大肥鱼在任务状态卡底部显示余额">

## 能做什么

- **多个产品共用一只桌宠**：接入的产品同时监听，桌宠先显示最需要你处理的（等你确认 > 出错 > 工作中），一样急时按设置页里拖出来的顺序；气泡和任务列表都标出是哪个产品。每个产品可以在设置页单独开关。
- **Claude Code**：通过 hooks 显示任务状态；气泡底部显示订阅额度，例如「Claude 额度 会话 10% · 本周 27%」。
- **DeepSeek Harness**：显示任务状态、步骤、多任务和待办进度；气泡底部显示 DeepSeek 余额。
- 支持拖动、贴边停靠（拖到屏幕左右边缘松手，点一下出来）、拖动倾斜、摸头、戳身体、碰尾巴，以及大小、气泡、声音和减少动态设置。
- 设置页和桌宠右键菜单可切换六套内置皮肤；皮肤会随思考、工作、等待、完成和出错状态切换表情。

状态全部来自 Agent 自己上报的事件，大肥鱼不会读取屏幕。Claude Code 的 hook 只转发事件类型、会话 ID、工作目录和工具名，不会转发你的提示词和文件内容。

## 工作方式

```
各产品 hooks（--source <产品>）─┐
                                 ├─> 大肥鱼守护进程 ─> 按优先级与顺序汇总 ─> 桌宠
DSH 插件 ────────────────────────┘
```

守护进程由 Claude Code 的 hook 或 DSH 插件按需自动启动，也可以用 `dafeiyu start` 手动启动。

## 安装

需要 Node.js 22.19 或以上。一条命令装好，不用装 Xcode、Python，也不用下载源码：

```bash
npm install -g https://github.com/seawhilt/dafeiyu/releases/latest/download/agent-dafeiyu.tgz
```

安装包里已经带了 macOS 和 Windows 的桌宠程序，约 280 MB，下载需要一会儿。装好后：

```bash
dafeiyu settings
```

这会启动桌宠，并在浏览器打开设置页，在页面上一键接入 Claude Code，或按提示接入 DeepSeek。以后也可以在桌宠上右键选「设置…」打开。

升级时先运行 `dafeiyu stop`，再重新运行一次上面的 `npm install -g` 命令。Windows 上这一步尤其重要：正在运行的守护进程会占用全局安装目录里的文件，不先停止可能升级失败。指定版本可以把 `latest/download/agent-dafeiyu.tgz` 换成 `download/v0.2.6/agent-dafeiyu-0.2.6.tgz`。卸载时先运行 `dafeiyu uninstall claude` 移除 hooks，再 `dafeiyu stop` 关闭守护进程，最后 `npm uninstall -g agent-dafeiyu`。

> 正式支持 macOS 和 Windows。Linux 没有预编译的桌宠程序，会回退到 Python 版，需要自己装 `python3` 与 `PySide6>=6.7,<7`，不保证效果。

### 接入 Claude Code

```bash
dafeiyu install claude
```

这条命令会在 `~/.claude/settings.json` 写入 hooks，原文件备份为 `settings.json.dafeiyu.bak`，之后新开的 Claude Code 会话生效。也可以在桌宠右键「设置…」里一键接入。

要撤销，运行 `dafeiyu uninstall claude`，或在设置页展开「接入说明」点「移除接入」。

> 从 0.2.x 升级：hooks 命令格式变了（带上 `--source claude`），升级后请重新运行一次 `dafeiyu install claude`。

订阅额度由守护进程每 5 分钟（以及每轮对话结束后）运行一次 `claude -p /usage` 读取。这是 Claude Code 的本地命令，不调用模型、不消耗 token，数字和官方用量页一致；只对 Claude.ai 订阅用户有数据。

### 接入 Codex

```bash
dafeiyu install codex
```

在 `~/.codex/hooks.json`（设置了 `CODEX_HOME` 时在该目录下）写入 hooks。**Codex 只运行审核过的 hooks**：写入后在 Codex 里运行一次 `/hooks`，审核并信任大肥鱼的条目，之后新开的会话生效。Codex 没有「请求失败」事件，所以出错时桌宠只会显示本轮结束；用户中断（Interrupt）显示为已停止。

### 接入 Cursor

```bash
dafeiyu install cursor
```

在 `~/.cursor/hooks.json` 写入 hooks。大肥鱼只注册不会拦截 Agent 的事件（提交提示、工具完成或失败、结束、会话结束），**不注册** `preToolUse`、`beforeShellExecution` 等需要返回放行决定的 hook。因此 Cursor 下桌宠用刚完成的工具表示正在做的事，也没有「等你确认」状态。Cursor 也会执行 `~/.claude/settings.json` 里的 hooks，这些事件会被识别出来，只按 Cursor 显示一次。

### 接入其他工具（Gemini CLI、Kimi、Qoder 等）

能在事件发生时执行命令的工具都可以接入，不用等大肥鱼单独适配。先打印给这个工具用的命令：

```bash
dafeiyu hook-command gemini
```

把输出的命令加到工具自己的 hooks 配置里。大肥鱼不会改这些工具的配置文件。

- 工具在 stdin 传 JSON 时：认 Claude Code 的字段（`hook_event_name`、`session_id`、`cwd`、`tool_name`）和事件名，Gemini CLI 的 `BeforeAgent` / `BeforeTool` / `AfterTool` / `AfterAgent` 也认得。
- 工具不传 JSON 时：在命令后加 `--event start`（开始）、`tool`（干活）、`waiting`（等你确认）、`done`（完成）、`error`（出错）或 `end`（会话结束）。

和内置产品一样，只有工具名、事件名、项目目录会发给桌宠，提示词和代码不会。桌宠上统一显示为「其他工具」，收到第一个事件后出现在设置页。

### 接入 DeepSeek Harness

先在 DSH 里卸载原版 dsh-dafeiyu，再从 [Release 页](https://github.com/seawhilt/dafeiyu/releases/latest) 下载 `agent-dafeiyu.tgz`，安装到对应客户端的 profile：

```bash
# 浏览器 WebUI
npx -y @deepseek-ai/dsh plugin --profile web add ./agent-dafeiyu.tgz
```

```bash
# 官方桌面端：必须使用桌面应用自带的 dsh 命令
dsh plugin --profile desktop add ./agent-dafeiyu.tgz
```

命令行安装前请先完全退出对应的 DSH，装好后再启动。桌面端也可以在「插件 → 添加插件」里填 `.tgz` 的完整路径。

插件设置里的「运行方式」默认为**共享桌宠**，即和 Claude Code 共用一只桌宠。改成**独立桌宠**后，行为与上游一致：只跟随 DSH，随 DSH 启停。

## 命令行

| 命令 | 作用 |
| --- | --- |
| `dafeiyu start` / `stop` | 启动 / 关闭守护进程 |
| `dafeiyu settings` | 打开桌宠设置页（也可在桌宠右键菜单选择「设置…」） |
| `dafeiyu status` | 查看已接入并启用的产品，以及正在显示的产品 |
| `dafeiyu install <产品>` / `uninstall <产品>` | 写入 / 移除某个产品的 hooks，例如 `install claude` |
| `dafeiyu daemon` | 前台运行守护进程，排查问题时用 |

守护进程的配置和日志在 `~/.dafeiyu/`，可以用环境变量 `DAFEIYU_HOME` 改位置。

## 余额与额度

| 产品 | 显示内容 | 数据来源 |
| --- | --- | --- |
| Claude | 会话额度、本周额度（百分比） | `claude -p /usage`（本地命令，不消耗 token） |
| DeepSeek | 总余额，设置页可看赠送和充值明细 | DSH 中配置的 API Key 或已登录账户 |

- DeepSeek 余额每分钟自动刷新；凭据在 DSH 的模型／账户设置中配置，大肥鱼不需要再填 API Key。
- API Key、登录凭据和上游原始错误不会进入余额页面、角色消息或事件流。
- 没有余额或额度数据时，任务状态照常显示。

## 常用设置

| 设置 | 作用 |
| --- | --- |
| 运行方式 | 共享桌宠（默认）或独立桌宠，仅 DSH 插件 |
| 角色大小 / 气泡大小 | 独立调整，右键菜单也能改 |
| 安静 / 标准 / 活泼 | 每次待机动作结束后，分别休息 20～40 / 8～15 / 3～6 秒 |
| 减少动态 | 固定角色姿势，停止待机与点击动画；状态和提示仍实时更新 |
| 提示音 | 完成／出错时播放声音 |
| 气泡显示 | 自动（默认：工作或有话要说时显示，空闲时收起）、常驻、隐藏，或仅在指定状态显示 |
| 子 Agent | 允许子 Agent 状态参与显示 |
| 显示余额 / 余额来源 | DeepSeek 余额的开关和来源 |

> 共享桌宠模式下，角色大小、气泡、待机动作、减少动态、提示音和碎碎念以桌宠设置页（`dafeiyu settings` 或右键「设置…」）为准；DSH 插件卡只保留运行方式、余额、子 Agent 等 DSH 侧设置。改成独立桌宠后，插件卡里的外观设置才生效。

右键菜单可以忽略出错提醒、调整大小、减少动态，或仅在本次运行隐藏／关闭角色。动作规则见 [动作说明](docs/animation-behavior.md)；新形象的骨骼动画制作与导入见 [动画素材制作](docs/animation-authoring.md)。

## 平台

| 平台 | 桌宠程序 |
| --- | --- |
| macOS 12+ | 原生 Swift / AppKit，Universal 构建 |
| Windows 10 / 11 x64 | Qt 程序，由 CI 打包；WSL2 可通过 Windows 互操作启动 |
| Linux | 非正式支持：没有预编译程序，回退到 Python 版，需要 `python3` 与 `PySide6>=6.7,<7` |

桌宠显示在**运行 Agent 的那台机器的桌面**上。远程服务器或没有图形界面的环境不会显示。

## 排错

- 守护进程日志：`~/.dafeiyu/daemon.log`
- 桌宠程序日志：
  - macOS：`~/Library/Logs/dafeiyu/helper.log`
  - Windows：`%LOCALAPPDATA%\dafeiyu\logs\helper.log`
  - Linux：`${XDG_STATE_HOME:-~/.local/state}/dafeiyu/helper.log`
- Claude Code 没反应：运行 `dafeiyu status`，确认显示「Claude hooks: 已安装」，并新开一个 Claude Code 会话。

## 源码开发

```bash
git clone https://github.com/seawhilt/dafeiyu.git
cd dafeiyu
npx pnpm@11 install --frozen-lockfile
npm run build:helper        # 构建当前平台的桌宠程序
npm link                    # 注册 dafeiyu 命令
```

```bash
npx pnpm@11 install --frozen-lockfile
npm test
npm run test:python
npm run build:helper
```

开发 Python 版桌宠需要 `requirements.txt` 中的依赖；macOS 版需要 Xcode Command Line Tools。改了原生代码后要重新构建桌宠程序。

## 参考与致谢

这个项目站在下面这些开源项目的肩膀上：

| 来源 | 用在哪里 | 协议 |
| --- | --- | --- |
| [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) | 项目起点：DSH 插件、原生桌宠程序、状态归约 | MIT |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 鲸尾女仆全部 108 段动画素材，碎碎念、动作菜单的思路 | MIT |
| [Chromium](https://chromium.googlesource.com/chromium/src/+/main/ui/resources/cursors/) | 拖拽时的手套光标 | BSD-3-Clause |
| [crafter-station/petdex](https://github.com/crafter-station/petdex) | 「从 petdex 安装」形象的宠物图库 | MIT |
| codex-pets 宠物格式、[eivmosn/dsh-pets](https://github.com/eivmosn/dsh-pets) | 换形象功能参考的格式和思路 | MIT |
| [savanna0425/llm-pet](https://github.com/savanna0425/llm-pet) | 11 组模型主题动画形象；ChatGPT Q 版用作「小龙女」 | 署名、非商业；DeepSeek 素材另需遵循 CC BY-NC-SA 4.0 |

- 代码采用 MIT 协议，见 [LICENSE](LICENSE)，其中保留了上游作者的版权声明。
- 角色动画的许可见 [assets/dsh-pet-LICENSE.txt](assets/dsh-pet-LICENSE.txt)，光标的许可见 [assets/cursors/](assets/cursors/)，完整说明见 [ASSET_LICENSE.md](ASSET_LICENSE.md)。
- `llm-pet` 美术素材由 ZipZipPipe 创作；DeepSeek 鲸鱼形象还基于上善的角色设定。它们不是 MIT 素材，使用时请遵守对应署名和非商业条件。
- 代码欢迎拿去玩、改、二次开发，保留上面的版权声明即可；美术素材请按各自许可使用。

本项目是非官方项目，与相关模型提供方无关。
