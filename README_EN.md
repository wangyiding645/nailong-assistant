<!-- NOTE: this English README is a condensed translation. The Chinese README.md and
     docs/ARCHITECTURE.md are authoritative and updated first. -->

<div align="center">

<img src="docs/screens/pet.png" width="160" alt="Nailong Assistant">

# Nailong Assistant (奶蛙助手)

**A tiny frog that lives on your desktop — it can see your screen and use your mouse & keyboard. An AI computer-use assistant that happens to be a desktop pet.**

[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white)](#)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-3DA639)](LICENSE)
[![Release](https://img.shields.io/github/v/release/wangyiding645/nailong-assistant?color=orange)](https://github.com/wangyiding645/nailong-assistant/releases/tag/v3.3.2)
[![Stars](https://img.shields.io/github/stars/wangyiding645/nailong-assistant?style=social)](https://github.com/wangyiding645/nailong-assistant/stargazers)

[简体中文](README.md) · [English](README_EN.md)

</div>

---

## Download for Windows

**3.3.2 · 2026-10-10 · Windows x64**

- [Installer](https://github.com/wangyiding645/nailong-assistant/releases/download/v3.3.2/nailong-assistant-3.3.2-win-x64.exe).
- [Portable](https://github.com/wangyiding645/nailong-assistant/releases/download/v3.3.2/nailong-assistant-3.3.2-win-x64-portable.exe): run from a writable directory; no separate Node.js or pi installation is needed.
- [Release notes and SHA-256 checksums](https://github.com/wangyiding645/nailong-assistant/releases/tag/v3.3.2).

This release: **history sessions actually open now** (an IPC handler was missing an `await`), and **Auto mode is actually automatic** (the "always confirm high-risk" switch was fake and unclickable); deleting a session now asks first. The previous round (data no longer wiped by reinstalling, no step limit on tool calls, bubble hidden by default) is included too. See the [changelog](CHANGELOG.md).

These binaries are published in this repository's Release. Exit the old app before upgrading and preserve `agent.json`, `settings.json`, `.userdata` and other personal data beside it. Use the same Windows account to read encrypted credentials.

## 🆕 v3.2 — bundled pi kernel, fully wired

Nailong ships **its own isolated pi configuration** and does **not** read the machine's `~/.pi`
by default (`PI_CODING_AGENT_DIR` points at `.userdata/pi-agent`; credentials come from Nailong's
own Base URL + API Key + model, registered as the `nailong` provider).

Why: another tool's config can break the app. Real case found here — `~/.pi/agent/settings.json`
had an `httpProxy` pointing at a proxy that was not running, so every model request failed with a
bare `Connection error.`. Now the app is isolated *and* runs a preflight that names the file, the
port and three ways out. Prefer your existing pi logins (subscriptions)? Switch to
"use the machine's pi config" in Settings → Model.


Nailong now runs **pi as its brain** in a child process (`pi --mode rpc`), while the app keeps
the hands: screen capture, UI Automation tree, mouse/keyboard, files, system, schedule.

- **54 tools** registered into pi via `pi-ext/nailong.mjs` (schemas streamed from a localhost-only,
  token-authenticated bridge) — add a tool on our side and pi gets it on next start.
- **Same permission model for both kernels**: dangerous actions always ask, no matter which brain runs.
- **Crash-isolated**: if pi dies the pet, schedule and pomodoro keep working and the UI silently
  falls back to the built-in engine.
- Switch in Settings: `auto / pi only / builtin only`. Your existing pi credentials and
  subscription logins are reused automatically.
- 59 tests (`npm run check`) including an end-to-end test that spawns a real pi process and
  verifies all 54 tools register. `npm run audit` checks 36 window/theme combinations, 23 view steps, six English-label pages and seven mode states
  headlessly for real clipping.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [SECURITY.md](docs/SECURITY.md) · [CHANGELOG.md](CHANGELOG.md).


### pi capabilities surfaced in the UI (3.2)

| Entry | What it does |
| --- | --- |
| 🧠 Model | lists every model pi can use (including subscription logins); one click to switch |
| 💭 Thinking | reasoning level `off … max`, limited to what the model supports |
| ⋯ → Compact | manual context compaction; context-window usage shows in the footer |
| ⋯ → Clone | branch the session; switching sessions replays real history incl. tool calls and screenshots |
| ⋯ → Commands & skills | pi's slash commands, prompt templates and skills (subagents, council, …) |
| Settings → Model | auto-compaction, auto-retry, default thinking level, context window |
| Settings → Model | **load your own pi extensions** (MCP servers, subagents, code mode) — off by default |

The last row is a deliberate trade-off: by default Nailong starts pi with `--no-extensions`, so your
other pi packages never run next to the app. Turning it on widens the trust boundary to every pi
package you installed; the UI says so explicitly.
See [SECURITY.md](docs/SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

---

## 🤖 Core: the AI computer-use assistant

> Most "AI assistants" only chat. **This one actually drives your computer.**

It sends a screenshot of your desktop to a multimodal LLM, and then **really** moves the mouse, clicks, types, presses hotkeys, scrolls and launches apps — step by step: act → screenshot → verify → continue, until the job is done.

Say *"open Notepad and write tomorrow's meeting note, save it to Desktop"* and it does exactly that.

### What it can do

| Tool | Description |
| --- | --- |
| 📷 `screenshot` | Capture and understand the screen (coordinates are in screenshot pixels) |
| 🖱 `click` / `dblclick` / `rightclick` | Click at any screen coordinate |
| ⌨️ `type` | Type text into the focused window (CJK supported via clipboard) |
| ⚡ `key` | Keys & combos: `enter`, `esc`, `ctrl+s`, `win+r`, `alt+tab`, `f5`… |
| 🖲 `scroll` | Scroll up/down |
| ⏳ `wait` | Wait for UI to load |
| 🚀 `launch` | Launch an app or URL: `notepad`, `explorer`, `https://…` |

### Three steps to use it

1. **Summon**: right-click the frog → **🤖 Assistant** (it changes into a suit-and-laptop work pose 🤵)
2. **Configure**: click **⚙** — **only Base URL + API Key are required** → *Save & test*
3. **Ask**: type your request and hit send

> ✅ **Minimal setup = 2 fields.** Leave the model empty and it auto-detects one from `/models` (preferring vision-capable models) and fills it in for you.

### Two execution modes

| Mode | Behaviour | When |
| --- | --- | --- |
| 🛡 **Confirm each step** (default) | Every action is shown first; you click *Execute / Skip / Auto for this task* | First runs, sensitive work |
| ⚡ **Auto** | Runs the whole task without asking | Trusted, repetitive tasks |

### Safety design

- 🔐 **Keys never leave your machine** — encrypted with Windows DPAPI (`safeStorage`), never uploaded, always shown as `••••••`
- 🕶 **The frog hides itself during screenshots** — so the AI never clicks the assistant UI or miscalculates coordinates
- 🧭 **Interruptible** — confirm mode by default; skip or stop anytime; every action is logged in the chat
- 🚫 **Hard limits in the system prompt** — no deleting files, payments, sending messages or system changes without asking you first

### Example prompts

| Goal | Say |
| --- | --- |
| Read the screen | "Look at my screen and tell me what the open app is doing" |
| Fill a form | "Open https://example.com and fill in my email xxx@qq.com" |
| Automate typing | "Open Notepad, write 'meeting at 9am', save to Desktop as note.txt" |
| Search | "Open Bing, search for today's weather and read it to me" |
| Diagnose | "Is there any error dialog on screen? Read it and dismiss it" |

<p align="center"><img src="docs/screens/panel.png" width="320" alt="Planner"> <img src="docs/screens/tool.png" width="320" alt="Tools"> <img src="docs/screens/menu.png" width="200" alt="Forms"></p>

---

## 🐸 And it's a decent desktop pet too

- 9 animation sets (idle / run / wave / belly-laugh / **suit & laptop while the assistant is open**), drag to move, position memory
- Hover = wave + today's schedule; click = planner
- Always on top; comes back after `Win + D`

### 📅 Schedule & reminders
- `schedule.txt`: `HH:MM|text` (daily) or `YYYY-MM-DD HH:MM|text` (one-off)
- On time: red flashing bubble + jump + chime · 5-minute heads-up · celebration when the day is cleared

### 🪟 Liquid-glass planner
- Live clock, calendar with holiday labels, countdown chips, check-off, streak counter
- Six quiet cream, white and muted dark themes; stable backgrounds, draggable & remembered

### 🎛️ Right-click forms
🤖 Assistant · ⏳ Countdown · ⏰ Alarm · 🪙 Coin flip · 🏃 Catch the frog (it flees your cursor!)

### 🗑️ Drag-to-recycle
Drop files on the frog → if the icon is on your desktop, **it runs over to the icon** and asks there → confirm → Recycle Bin + spin & laugh. **Each meal makes it 10% bigger** (Settings → Appearance has a 50%–999% size slider).

<p align="center"><img src="docs/screens/recycle.png" width="280" alt="Recycle"> <img src="docs/screens/catch.png" width="400" alt="Catch"></p>

---

## 📦 Download & run (Windows x64)

| File | How to use |
| --- | --- |
| `nailong-assistant-3.3.2-win-x64-portable.exe` (133MB) | **No install.** Double-click and it runs. Your data (schedule, settings, conversations) is written **next to the exe**, so copying the folder moves everything. |
| `nailong-assistant-3.3.2-win-x64.exe` (133MB) | Installer wizard; creates shortcuts and does **not** delete your data on uninstall. |

Both are complete builds with the bundled pi kernel — no Node, no pre-installed pi.
First run creates `schedule.txt`, `settings.json` and `.userdata/` next to the app, all plain text
you can edit by hand.

Then: right-click the frog → **⚙ Settings** → fill **Base URL + API Key** once → right-click → **🤖 Assistant**.
Schedule, pomodoro, reminders and the desktop pet work with **no API key at all**.

Build it yourself: `npm run dist` (both targets).

---

## 🚀 Quick start

### Option A — Portable build (recommended)
Download `nailong-assistant-vX.Y.Z-win-x64.exe` from [**Releases**](../../releases) and run it. No installer, no registry writes.

### Option B — From source
```bash
git clone https://github.com/wangyiding645/nailong-assistant.git
cd nailong-assistant
npm install     # only Electron
npm start
```
Windows 10/11 + Node.js 18+.

---

## 🧠 Engineering notes

<details>
<summary><b>Architecture</b></summary>

- Electron 44, frameless transparent always-on-top windows (pet / planner / assistant / tools / menu)
- Plain local data files — hand-editable, git-friendly; renderers have no Node access (contextBridge only)
- The AI loop lives in the **main process**: `screenshot → tool_call → execute → feed back screenshot → decide`, using standard OpenAI function calling
- `native/*.ps1` handles OS chores: z-order pinning, restore after Win+D, DPI-aware input injection, wallpaper blur sampling, desktop icon coordinates, Recycle Bin

</details>

<details>
<summary><b>Gotchas we hit (so you don't)</b></summary>

1. `setPosition` on a transparent frameless window **grows it ~1px per call** → always move with `setBounds`
2. Windows PowerShell 5.1 mis-decodes BOM-less `.ps1` with CJK → keep scripts ASCII, pass titles as arguments
3. Semi-transparent pixels in the sprite sheet let the wallpaper bleed through → force interior alpha to 255
4. On Win11 the desktop icon list is **not** a direct child of `Progman` → enumerate all `SysListView32` and require a `Progman/WorkerW` ancestor
5. Cross-process `LVM_GETITEMRECT` needs `VirtualAllocEx base + offset` (forgetting the base returns zeros)
6. Screenshots would capture our own windows → `setOpacity(0)` them during capture
7. Assistant loses focus during automation → 📌 pin (`screen-saver` level + visible on fullscreen + watchdog)

</details>

---

## 🗺️ Roadmap

- [ ] More assistant abilities: clipboard, batch rename, scheduled tasks
- [ ] NSIS installer + auto-update
- [ ] More forms & mini-games
- [ ] Multi-monitor / multi-DPI polish
- [ ] English UI (i18n)

## ⚠️ Disclaimer

The assistant **really controls your mouse and keyboard**. Use confirm mode first and never let it handle payments or deletions. Recycle uses the system Recycle Bin (recoverable), but double-check before confirming. API costs are on your account.

## 🙏 Credits

- Character animations / sound from the nailong asset library; if you are the original artist and want different attribution or licensing, please open an issue.
- Inspired by desktop pets, Tamagotchi and "computer use" agents.

## 📄 License

[MIT](LICENSE) © 2026 wangyiding645
