import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTerminal, splitCommand, type Deps } from "./resolve.ts";

const KITTY_DESKTOP = `[Desktop Entry]
Exec=kitty
Categories=System;TerminalEmulator;
X-TerminalArgExec=--
X-TerminalArgDir=--working-directory
`;

function fakeDeps(options: {
  env: NodeJS.ProcessEnv;
  bins: string[];
  files?: Record<string, string>;
  commands?: Record<string, string>;
}): Deps {
  return {
    env: { PATH: "/bin", HOME: "/home/u", ...options.env },
    run: async (command, args) => options.commands?.[[command, ...args].join(" ")],
    readFile: async (path) => options.files?.[path],
    isExecutable: async (path) => options.bins.some((bin) => `/bin/${bin}` === path),
  };
}

const COMMAND = ["/bin/node", "runner.mjs", "--run-id", "a b"];

test("KDE uses TerminalService desktop entry args", async () => {
  const deps = fakeDeps({
    env: { XDG_CURRENT_DESKTOP: "KDE" },
    bins: ["kreadconfig6", "kitty", "konsole"],
    commands: { "/bin/kreadconfig6 --file kdeglobals --group General --key TerminalService": "kitty.desktop" },
    files: { "/usr/share/applications/kitty.desktop": KITTY_DESKTOP },
  });
  const terminal = await resolveTerminal(deps);
  assert.deepEqual(terminal?.argv("/work", COMMAND), ["/bin/kitty", "--working-directory", "/work", "--", ...COMMAND]);
});

test("KDE falls back to TerminalApplication", async () => {
  const deps = fakeDeps({
    env: { XDG_CURRENT_DESKTOP: "KDE" },
    bins: ["kreadconfig6", "konsole"],
    commands: { "/bin/kreadconfig6 --file kdeglobals --group General --key TerminalApplication": "konsole --separate" },
  });
  const terminal = await resolveTerminal(deps);
  assert.deepEqual(terminal?.argv("/work", COMMAND), ["/bin/konsole", "--separate", "-e", ...COMMAND]);
});

test("Cinnamon uses gsettings exec and exec-arg", async () => {
  const key = "/bin/gsettings get org.cinnamon.desktop.default-applications.terminal";
  const deps = fakeDeps({
    env: { XDG_CURRENT_DESKTOP: "X-Cinnamon" },
    bins: ["gsettings", "tilix"],
    commands: { [`${key} exec`]: "'tilix'", [`${key} exec-arg`]: "'-e'" },
  });
  const terminal = await resolveTerminal(deps);
  assert.deepEqual(terminal?.argv("/work", COMMAND), ["/bin/tilix", "-e", ...COMMAND]);
});

test("COSMIC uses mimeapps.list terminal default", async () => {
  const deps = fakeDeps({
    env: { XDG_CURRENT_DESKTOP: "COSMIC" },
    bins: ["kitty", "cosmic-term"],
    files: {
      "/home/u/.config/mimeapps.list": "[Default Applications]\nx-scheme-handler/terminal=kitty.desktop;\n",
      "/home/u/.local/share/applications/kitty.desktop": KITTY_DESKTOP,
    },
  });
  const terminal = await resolveTerminal(deps);
  assert.equal(terminal?.source, "COSMIC default kitty.desktop");
});

test("GNOME prefers xdg-terminal-exec, then GLib's list", async () => {
  const env = { XDG_CURRENT_DESKTOP: "GNOME" };
  const withXte = await resolveTerminal(fakeDeps({ env, bins: ["xdg-terminal-exec", "kgx"] }));
  assert.deepEqual(withXte?.argv("/work", COMMAND), ["/bin/xdg-terminal-exec", "--dir=/work", ...COMMAND]);
  const withoutXte = await resolveTerminal(fakeDeps({ env, bins: ["gnome-terminal", "xterm"] }));
  assert.deepEqual(withoutXte?.argv("/work", COMMAND), ["/bin/gnome-terminal", "--", ...COMMAND]);
});

test("Window managers fall back to $TERMINAL", async () => {
  const deps = fakeDeps({ env: { XDG_CURRENT_DESKTOP: "Hyprland", TERMINAL: "foot" }, bins: ["foot", "xterm"] });
  assert.deepEqual((await resolveTerminal(deps))?.argv("/work", COMMAND), ["/bin/foot", "-e", ...COMMAND]);
});

test("Returns undefined when nothing is installed", async () => {
  assert.equal(await resolveTerminal(fakeDeps({ env: {}, bins: [] })), undefined);
});

test("splitCommand honours desktop entry quoting", () => {
  assert.deepEqual(splitCommand('"/opt/My Term/term" --flag "a \\"b\\"" %U'), ["/opt/My Term/term", "--flag", 'a "b"', "%U"]);
});
