<div align="center">

# BigFish (大肥鱼) 🐋

**A desktop companion that shows what your coding agent is doing, shared by Claude Code and DeepSeek Harness.**

[中文](README.md) · [Changelog](CHANGELOG.md) · [License notice](ASSET_LICENSE.md)

</div>

BigFish is a transparent, always-on-top desktop character. While you work in your editor or browser, it shows the agent's live state: thinking, searching, editing, running, waiting for approval, done, or failed.

This project started from [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) (see Credits). It adds Claude Code support and switching between providers to the original DeepSeek Harness (DSH) plugin.

## Features

- **One pet for both providers.** Whichever provider you configure is used. With both configured, switch from the right-click **服务商** (provider) menu; the choice is remembered.
- **Claude Code**: task state through hooks, and your subscription usage (session and weekly) in the bubble footer.
- **DeepSeek Harness**: task state, steps, multiple tasks and todo progress, plus your DeepSeek balance.
- **Hands-on**: drag it around, drop it against a screen side to dock it (click once to bring it back), tilt it while dragging, pat its head or poke it. Size, bubble, sound and reduced-motion options are in the settings page.
- **Characters and chatter**: switch between the built-in whale-tail maid and codex-pets characters, install pets from [petdex](https://petdex.dev/collections) by pasting a name or link, and edit the bubble lines (including idle chatter) in the settings page.

State comes only from events the agent reports. The pet never reads the screen, and the Claude Code hook forwards event types, session IDs, working directories and tool names only, never prompts or file contents.

## Install

Requires Node.js 22.19+. One command, no Xcode, Python or source checkout needed:

```bash
npm install -g https://github.com/seawhilt/dafeiyu/releases/latest/download/agent-dafeiyu.tgz
```

The package carries the pet program for macOS and Windows (about 280 MB); Linux is unofficial and falls back to the Python helper, which needs `python3` and `PySide6`. Then run `dafeiyu settings` to start the pet and open its settings page, where Claude Code is one click away. To build from source instead: clone the repo, `npx pnpm@11 install --frozen-lockfile`, `npm run build:helper`, `npm link`.

**Upgrade and uninstall**: run `dafeiyu stop` first, then re-run the install command. On Windows this matters: the running daemon holds files in the global install directory, so upgrading without stopping can fail. To pin a version, replace `latest/download/agent-dafeiyu.tgz` with `download/v0.2.6/agent-dafeiyu-0.2.6.tgz`. To uninstall, remove the Claude Code hooks with `dafeiyu uninstall-claude`, stop the daemon with `dafeiyu stop`, then `npm uninstall -g agent-dafeiyu`.

**Claude Code**: run `dafeiyu install-claude` (or right-click the pet → 设置… → 一键接入). It adds hooks to `~/.claude/settings.json`; `dafeiyu uninstall-claude` removes them. Subscription usage is read every five minutes with `claude -p /usage`, a local command that calls no model and uses no tokens.

**DeepSeek Harness**: download `agent-dafeiyu.tgz` from the [latest release](https://github.com/seawhilt/dafeiyu/releases/latest) and install it with `dsh plugin --profile web add <path>` (WebUI) or the desktop app's bundled `dsh plugin --profile desktop add <path>`. The plugin's **运行方式** (mode) setting defaults to shared; standalone keeps the upstream behaviour.

## Commands

`dafeiyu start | stop | settings | status | use <claude|deepseek> | install-claude | uninstall-claude | forget-deepseek | daemon`

`dafeiyu settings` opens the pet's own settings page (the same as right-click → 设置…); `dafeiyu daemon` runs the daemon in the foreground for debugging. Daemon settings and logs live in `~/.dafeiyu/` (override with `DAFEIYU_HOME`).

## Settings

The pet settings page (right-click → 设置… or `dafeiyu settings`) owns the character, bubble lines, size, idle activity level, reduced motion, sound and bubble display mode. In **shared** mode the DSH plugin card keeps only DSH-side settings (mode, balance, sub-agents) and points to this page, because the shared daemon owns the appearance settings. Switch the plugin to **independent** mode if you want the appearance settings in the DSH card to control the pet.

## License

Code is MIT ([LICENSE](LICENSE), keeping the upstream copyright notice). Character frames come from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) under MIT, and the glove cursors come from Chromium under BSD-3-Clause. See [ASSET_LICENSE.md](ASSET_LICENSE.md). This is an unofficial project, not affiliated with DeepSeek or Anthropic.

## Credits

Built on [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) (starting point, MIT), with character frames from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT), glove cursors from Chromium (BSD-3-Clause), the [petdex](https://github.com/crafter-station/petdex) gallery (MIT), and ideas from the codex-pets format and [eivmosn/dsh-pets](https://github.com/eivmosn/dsh-pets). Feel free to play with it, change it and build on it; keep the copyright notices.
