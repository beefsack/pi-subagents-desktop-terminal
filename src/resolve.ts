import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface Deps {
  env: NodeJS.ProcessEnv;
  /** Trimmed stdout, or undefined when the command fails. */
  run(command: string, args: string[]): Promise<string | undefined>;
  readFile(path: string): Promise<string | undefined>;
  isExecutable(path: string): Promise<boolean>;
}

export interface Terminal {
  /** Where the choice came from, for user-facing messages. */
  source: string;
  argv(cwd: string, command: string[]): string[];
}

export const systemDeps = (env: NodeJS.ProcessEnv): Deps => ({
  env,
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { env, timeout: 5_000, encoding: "utf8" }, (error, stdout) =>
        resolve(error ? undefined : stdout.trim()),
      );
    }),
  readFile: (path) => readFile(path, "utf8").catch(() => undefined),
  isExecutable: (path) => access(path, constants.X_OK).then(() => true, () => false),
});

// GLib's fallback order in gio/gdesktopappinfo.c, used by GNOME.
const GLIB_TERMINALS: [string, string][] = [
  ["kgx", "-e"],
  ["gnome-terminal", "--"],
  ["mate-terminal", "-x"],
  ["xfce4-terminal", "-x"],
  ["tilix", "-e"],
  ["konsole", "-e"],
  ["nxterm", "-e"],
  ["color-xterm", "-e"],
  ["rxvt", "-e"],
  ["dtterm", "-e"],
  ["xterm", "-e"],
];

export async function resolveTerminal(deps: Deps): Promise<Terminal | undefined> {
  const desktops = (deps.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().split(":").filter(Boolean);
  const steps: (() => Promise<Terminal | undefined>)[] = [];
  if (desktops.includes("kde")) steps.push(() => fromKde(deps));
  if (desktops.some((d) => d === "x-cinnamon" || d === "cinnamon")) steps.push(() => fromCinnamon(deps));
  if (desktops.includes("cosmic")) steps.push(() => fromCosmic(deps, desktops));
  steps.push(
    async () => {
      const path = await which(deps, "xdg-terminal-exec");
      return path ? terminal("xdg-terminal-exec", [path], undefined, "--dir=") : undefined;
    },
    async () => {
      const value = deps.env.TERMINAL?.trim();
      return value ? fromCommand(deps, "$TERMINAL", splitCommand(value), "-e") : undefined;
    },
    async () => {
      for (const [name, execArg] of GLIB_TERMINALS) {
        const path = await which(deps, name);
        if (path) return terminal(name, [path], execArg);
      }
      return undefined;
    },
  );
  for (const step of steps) {
    const found = await step();
    if (found) return found;
  }
  return undefined;
}

async function fromKde(deps: Deps): Promise<Terminal | undefined> {
  for (const tool of ["kreadconfig6", "kreadconfig5"]) {
    const path = await which(deps, tool);
    if (!path) continue;
    const read = (key: string) => deps.run(path, ["--file", "kdeglobals", "--group", "General", "--key", key]);
    const service = await read("TerminalService");
    const fromService = service && (await fromDesktopId(deps, `KDE TerminalService ${service}`, service));
    if (fromService) return fromService;
    const application = await read("TerminalApplication");
    if (application) return fromCommand(deps, "KDE TerminalApplication", splitCommand(application), "-e");
    return undefined;
  }
  return undefined;
}

async function fromCinnamon(deps: Deps): Promise<Terminal | undefined> {
  const gsettings = await which(deps, "gsettings");
  if (!gsettings) return undefined;
  const read = async (key: string) => {
    const value = await deps.run(gsettings, ["get", "org.cinnamon.desktop.default-applications.terminal", key]);
    return value?.match(/^'(.*)'$/)?.[1];
  };
  const exec = await read("exec");
  if (!exec) return undefined;
  return fromCommand(deps, "Cinnamon default terminal", splitCommand(exec), (await read("exec-arg")) ?? "");
}

async function fromCosmic(deps: Deps, desktops: string[]): Promise<Terminal | undefined> {
  // cosmic-settings stores the default terminal under these mimeapps.list keys.
  for (const mime of ["x-scheme-handler/terminal", "application/x-terminal-emulator"]) {
    for (const id of await mimeDefaults(deps, desktops, mime)) {
      const found = await fromDesktopId(deps, `COSMIC default ${id}`, id);
      if (found) return found;
    }
  }
  return fromDesktopId(deps, "COSMIC Terminal", "com.system76.CosmicTerm.desktop");
}

async function fromCommand(deps: Deps, source: string, command: string[], execArg: string) {
  const [name, ...args] = command;
  const path = name && (await which(deps, name));
  return path ? terminal(source, [path, ...args], execArg) : undefined;
}

export async function fromDesktopId(deps: Deps, source: string, id: string): Promise<Terminal | undefined> {
  for (const dir of dataDirs(deps.env)) {
    const text = await deps.readFile(join(dir, "applications", id));
    if (text === undefined) continue;
    const entry = parseDesktopEntry(text);
    if (!entry.Exec) return undefined;
    const exec = splitCommand(entry.Exec).filter((arg) => !/^%[a-zA-Z]$/.test(arg));
    const path = exec[0] && (await which(deps, exec[0]));
    if (!path) return undefined;
    const execArg = entry["X-TerminalArgExec"] ?? entry.TerminalArgExec ?? entry["X-ExecArg"] ?? entry.ExecArg ?? "-e";
    const dirArg = entry["X-TerminalArgDir"] ?? entry.TerminalArgDir;
    return terminal(source, [path, ...exec.slice(1)], execArg, dirArg);
  }
  return undefined;
}

function terminal(source: string, exec: string[], execArg: string | undefined, dirArg?: string): Terminal {
  return {
    source,
    argv: (cwd, command) => [
      ...exec,
      ...(!dirArg ? [] : dirArg.endsWith("=") ? [dirArg + cwd] : [dirArg, cwd]),
      ...(execArg ? [execArg] : []),
      ...command,
    ],
  };
}

async function which(deps: Deps, name: string): Promise<string | undefined> {
  if (name.includes("/")) return (await deps.isExecutable(name)) ? name : undefined;
  for (const dir of (deps.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    if (await deps.isExecutable(path)) return path;
  }
  return undefined;
}

async function mimeDefaults(deps: Deps, desktops: string[], mime: string): Promise<string[]> {
  // Lookup order from the freedesktop mime-apps specification.
  const configDirs = [configHome(deps.env), ...splitDirs(deps.env.XDG_CONFIG_DIRS, "/etc/xdg")];
  const dataAppDirs = dataDirs(deps.env).map((dir) => join(dir, "applications"));
  const files = [...configDirs, ...dataAppDirs].flatMap((dir) => [
    ...desktops.map((desktop) => join(dir, `${desktop}-mimeapps.list`)),
    join(dir, "mimeapps.list"),
  ]);
  const ids: string[] = [];
  for (const file of files) {
    const text = await deps.readFile(file);
    const value = text && parseIni(text)["Default Applications"]?.[mime];
    if (value) ids.push(...value.split(";").filter(Boolean));
  }
  return ids;
}

function parseDesktopEntry(text: string): Record<string, string> {
  return parseIni(text)["Desktop Entry"] ?? {};
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const groups: Record<string, Record<string, string>> = {};
  let group: Record<string, string> | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[(.+)\]$/);
    if (header) {
      group = groups[header[1]!] ??= {};
    } else if (group && trimmed && !trimmed.startsWith("#")) {
      const eq = trimmed.indexOf("=");
      if (eq > 0) group[trimmed.slice(0, eq).trim()] ??= unescapeValue(trimmed.slice(eq + 1).trim());
    }
  }
  return groups;
}

function unescapeValue(value: string): string {
  const map: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };
  return value.replace(/\\([sntr\\])/g, (_, c: string) => map[c]!);
}

/** Splits a desktop entry Exec value or simple command line, honouring double quotes. */
export function splitCommand(value: string): string[] {
  const args: string[] = [];
  let current: string | undefined;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted) {
      if (c === '"') quoted = false;
      else current = (current ?? "") + (c === "\\" && i + 1 < value.length ? value[++i] : c);
    } else if (c === '"') {
      quoted = true;
      current ??= "";
    } else if (/\s/.test(c)) {
      if (current !== undefined) args.push(current);
      current = undefined;
    } else {
      current = (current ?? "") + c;
    }
  }
  if (current !== undefined) args.push(current);
  return args;
}

function configHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
}

function dataDirs(env: NodeJS.ProcessEnv): string[] {
  return [env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), ...splitDirs(env.XDG_DATA_DIRS, "/usr/local/share:/usr/share")];
}

function splitDirs(value: string | undefined, fallback: string): string[] {
  return (value || fallback).split(":").filter(Boolean);
}
