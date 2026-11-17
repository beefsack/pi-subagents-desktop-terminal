# pi-subagents-desktop-terminal

A [pi-subagents](https://www.npmjs.com/package/pi-subagents) inspector plugin that opens subagent inspectors (Fleet `Enter`/`H`, `inspector.open`) in a new window of your desktop's default terminal, instead of a tmux, Herdr, or Ghostty split. Useful with tiling window managers.

## Install

```bash
pi install git:github.com/beefsack/pi-subagents-desktop-terminal
```

Requires `pi-subagents` and a Linux graphical session (`WAYLAND_DISPLAY` or `DISPLAY`). Built-in pi-subagents inspectors (Herdr, Ghostty, tmux) take priority when available.

## Terminal resolution

The desktop is detected from `XDG_CURRENT_DESKTOP`, and the first match wins:

| Desktop | Setting |
|---|---|
| KDE Plasma | `kdeglobals` `[General]` `TerminalService`, then `TerminalApplication` (via `kreadconfig6`/`kreadconfig5`) |
| Cinnamon | `org.cinnamon.desktop.default-applications.terminal` `exec` and `exec-arg` |
| COSMIC | `mimeapps.list` default for `x-scheme-handler/terminal` or `application/x-terminal-emulator`, then COSMIC Terminal |
| Any (including GNOME, Hyprland, Sway) | [`xdg-terminal-exec`](https://github.com/Vladimir-csp/xdg-terminal-exec), then `$TERMINAL`, then GLib's built-in terminal list |

When the default comes from a desktop entry, its `X-TerminalArgExec` and `X-TerminalArgDir` keys from the proposed [Default Terminal Execution Specification](https://gitlab.freedesktop.org/terminal-wg/specifications/-/merge_requests/3) are used, falling back to `-e`.

## Limitations

- Linux only.
- Window focus is left to the window manager, so `options.focus` is ignored.
- No inspector binding is recorded, so `inspector.status` and `inspector.close` are unavailable. Close the window directly; this never stops the subagent.

## Development

```bash
npm install
npm run typecheck
npm test
```
