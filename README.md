# opencode-sidebar-metrics-pro

**English** | [简体中文](#简体中文)

> Built for **OpenCode V2** — V1 (`tui.json`) is not supported.

Real-time performance metrics in the OpenCode TUI sidebar, small and light.

```
Metrics Pro ▼
Speed 12.4 tokens/s
Cache 87%
TTFT 2.7s
In 12,340 · Out 2,105 tokens
Last 37.1 tokens/s · 3.3s · 12s
```

## Features

- Collapsible `Metrics Pro ▼/▶` header, expanded by default, state kept in memory (survives reload, cleared on exit).
- Three live metrics: Speed, Cache hit rate, TTFT, computed over completed assistant messages only.
- `Last` line for the latest round in `Last <speed> · <ttft> · <elapsed>` form (e.g. `Last 37.1 tokens/s · 3.3s · 12s`), ordered speed, TTFT, single-round elapsed.
- `In/Out` line with thousand separators and lowercase `tokens`.
- One-line footer status in `prompt.footer.status`: Speed · Cache · TTFT · elapsed, automatically added, no setup needed; follows the subagent toggle, not rendered without a session.
- Two slash commands: `/metrics-pro` and `/metrics-pro-subagents`.
- Subagent rollup is off by default; when on, the header shows a `+sub` marker.

## Metrics

| Metric | Definition | Scope | `-` means |
| --- | --- | --- | --- |
| Speed | total `(output + reasoning)` divided by total elapsed time over completed assistant messages | Session (or family when `+sub` is on) | No completed generation yet |
| Cache | `cacheRead / (input + cacheRead + cacheWrite)` | Session (or family when `+sub` is on) | No token usage yet |
| TTFT | Mean of `earliest content.time.created - message.time.created` per message; completed messages only, no streaming midpoints to avoid flicker | Session (or family when `+sub` is on) | No completed message with content yet |
| Last | `Last 37.1 tokens/s · 3.3s · 12s` — format is `Last <speed> · <ttft> · <elapsed>` (ordered speed, TTFT, single-round elapsed), last completed assistant message only, never affected by the subagent toggle | Main session only | No completed round yet |

Display notes: labels use the native text color, values are muted; `In` counts `input`, `Out` counts `output + reasoning` (e.g. `In 12,340 · Out 2,105 tokens`, `In - · Out - tokens` when empty); footer compacts to `12.4 tokens/s · 87% · 2.7s · 24m`, where elapsed is session wall-clock time in `Xm` / `XhYYm`.

## Install

> npm package pending — not published yet. Use method A once live, method B for now.

A — npm (primary, once published):

```sh
opencode plugin add opencode-sidebar-metrics-pro
```

Or in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-sidebar-metrics-pro"]
}
```

B — local temp install via symlink:

```sh
npm run check
mkdir -p ~/.config/opencode/plugins/metrics-pro
ln -s "$(pwd)/dist/tui.js" ~/.config/opencode/plugins/metrics-pro/tui.js
```

Or point `cli.json` at a local file path:

```json
{
  "plugins": ["/absolute/path/to/opencode-sidebar-metrics-pro/dist/tui.js"]
}
```

Restart the OpenCode TUI after install.

## Commands

| Command | Effect | Usage |
| --- | --- | --- |
| `/metrics-pro` | Toggle the sidebar panel collapsed/expanded | Slash command or command palette |
| `/metrics-pro-subagents` | Toggle subagent rollup (header shows `+sub` when on) | Slash command or command palette; `Last` line stays main-session only |

## Requirements

- OpenCode V2 only.
- Terminal wide enough to show the sidebar (`sidebar.content` slot).
- If the panel is not visible, widen the terminal first to confirm the sidebar is shown.
- `@opentui/core`, `@opentui/solid`, `solid-js` are peer dependencies resolved by the OpenCode runtime — do not install them yourself.

## Development

```sh
npm install
npm run check   # tsc + build -> dist/tui.js (prepack runs it automatically)
ln -s "$(pwd)/dist/tui.js" ~/.config/opencode/plugins/metrics-pro/tui.js   # local trial
```

Perf notes: subscribed refresh events (`session.execution.succeeded`, `session.execution.failed`, `session.step.ended`, `session.text.ended`, `session.reasoning.ended`, `session.usage.updated`, `session.compaction.ended`); host auto-sync is trusted, events only bump revision to trigger recompute (one active sync on mount covers new-window history); fingerprint cache skips redundant recompute.

## License

MIT — 88-Rising. Repo: https://github.com/88-Rising/opencode-sidebar-metrics-pro

---

# 简体中文

[English](#opencode-sidebar-metrics-pro) | **简体中文**

> 适配 **OpenCode V2** —— 不支持 V1（`tui.json`）。

轻量性能指标插件：OpenCode TUI 侧边栏实时性能指标，小而轻。

```
Metrics Pro ▼
Speed 12.4 tokens/s
Cache 87%
TTFT 2.7s
In 12,340 · Out 2,105 tokens
Last 37.1 tokens/s · 3.3s · 12s
```

## 功能

- 可折叠标题 `Metrics Pro ▼/▶`，默认展开，折叠状态存 memory（reload 保留，退出丢失）。
- 三个实时指标：Speed、Cache 缓存命中率、TTFT，只统计 completed 的 assistant 消息。
- `Last` 行展示末轮数据，形态为 `Last <speed> · <ttft> · <elapsed>`（如 `Last 37.1 tokens/s · 3.3s · 12s`），依次为速度、TTFT、单轮耗时。
- `In/Out` 行带千分位分隔符，小写 `tokens`。
- `prompt.footer.status` 单行 footer：Speed · Cache · TTFT · elapsed，自动注入、无需配置；跟随子代理开关，无会话时不渲染。
- 两个斜杠命令：`/metrics-pro` 与 `/metrics-pro-subagents`。
- 子代理计入默认关闭；开启后标题显示 `+sub` 标记。

## 口径

| 指标 | 定义 | 范围 | `-` 语义 |
| --- | --- | --- | --- |
| Speed | completed assistant 消息的 `(output + reasoning)` 总量除以总耗时（总量相除，非单条平均） | 会话（`+sub` 开启时为 family） | 尚无已完成的生成 |
| Cache | `cacheRead / (input + cacheRead + cacheWrite)` | 会话（`+sub` 开启时为 family） | 尚无 token 用量 |
| TTFT | 每条消息 `最早 content.time.created - message.time.created` 的均值；仅 completed 消息，不取 streaming 中间值防闪烁 | 会话（`+sub` 开启时为 family） | 尚无带 content 的 completed 消息 |
| Last | `Last 37.1 tokens/s · 3.3s · 12s` —— 形态为 `Last <speed> · <ttft> · <elapsed>`，依次为速度、TTFT、单轮耗时，仅末轮 completed assistant 消息，不受子代理开关影响 | 仅主会话 | 尚无已完成的一轮 |

显示说明：label 用原生 text 色，数值 muted 灰；`In` 计 `input`，`Out` 计 `output + reasoning`（如 `In 12,340 · Out 2,105 tokens`，无数据时 `In - · Out - tokens`）；footer 紧凑为 `12.4 tokens/s · 87% · 2.7s · 24m`，其中 elapsed 为会话墙钟耗时，格式 `Xm` / `XhYYm`。

## 安装

> npm 包即将发布，暂未上线。发布后用方法 A，当前用方法 B。

A —— npm（发布后为主方式）：

```sh
opencode plugin add opencode-sidebar-metrics-pro
```

或写 `~/.config/opencode/cli.json`：

```json
{
  "plugins": ["opencode-sidebar-metrics-pro"]
}
```

B —— 本地临时 symlink：

```sh
npm run check
mkdir -p ~/.config/opencode/plugins/metrics-pro
ln -s "$(pwd)/dist/tui.js" ~/.config/opencode/plugins/metrics-pro/tui.js
```

或在 `cli.json` 里直接写文件路径：

```json
{
  "plugins": ["/absolute/path/to/opencode-sidebar-metrics-pro/dist/tui.js"]
}
```

安装后重启 OpenCode TUI。

## 命令

| 命令 | 作用 | 用法 |
| --- | --- | --- |
| `/metrics-pro` | 折叠开关：展开/收起侧边栏面板 | 斜杠命令或命令面板 |
| `/metrics-pro-subagents` | 子代理计入开关（开启时标题带 `+sub` 标记） | 斜杠命令或命令面板；`Last` 行不受影响 |

## 环境要求

- 仅支持 OpenCode V2。
- 终端宽度需能显示侧边栏（`sidebar.content` 槽位）。
- 若看不到面板，先加宽终端确认 sidebar 可见。
- `@opentui/core`、`@opentui/solid`、`solid-js` 为 peer 依赖，由 OpenCode 运行时解析，无需自装。

## 本地开发

```sh
npm install
npm run check   # tsc + build 出 dist/tui.js（prepack 自动执行）
ln -s "$(pwd)/dist/tui.js" ~/.config/opencode/plugins/metrics-pro/tui.js   # 本地试用
```

性能说明：订阅刷新事件（`session.execution.succeeded`、`session.execution.failed`、`session.step.ended`、`session.text.ended`、`session.reasoning.ended`、`session.usage.updated`、`session.compaction.ended`），信任宿主自动同步、事件仅 bump revision 触发重算（挂载时主动 sync 一次兜底新窗口历史），指纹缓存跳过重复计算。

## 许可证

MIT — 88-Rising。仓库：https://github.com/88-Rising/opencode-sidebar-metrics-pro
