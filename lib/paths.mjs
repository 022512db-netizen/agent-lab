import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Code and bundled defaults live inside the app checkout/bundle. User data
// must live outside it, otherwise an upgrade replaces settings and secrets.
export const ROOT = path.resolve(HERE, "..");
export const BUNDLED_CODEX_HOME = path.join(ROOT, "codex-home");
export const BUNDLED_CONFIG_FILE = path.join(BUNDLED_CODEX_HOME, "config.toml");
export const BUNDLED_MODEL_CATALOGS = path.join(BUNDLED_CODEX_HOME, "model-catalogs");
export const BUNDLED_ENV_FILE = path.join(ROOT, ".env");
export const BUNDLED_SETTINGS_FILE = path.join(ROOT, "agent-lab.settings.json");
export const BUNDLED_PROJECTS_FILE = path.join(ROOT, "projects.json");

function defaultDataDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AgentLab");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AgentLab");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "AgentLab");
}

export const DATA_DIR = path.resolve(process.env.AGENT_LAB_DATA_DIR || defaultDataDir());
export const USER_CODEX_HOME = path.join(DATA_DIR, "codex-home");

const configuredCodexHome = process.env.AGENT_CODEX_HOME;
export const CODEX_HOME =
  configuredCodexHome === "global"
    ? process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
    : path.resolve(configuredCodexHome || USER_CODEX_HOME);
export const USING_MANAGED_CODEX_HOME = path.resolve(CODEX_HOME) === path.resolve(USER_CODEX_HOME);

export const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
export const ENV_FILE = path.join(DATA_DIR, ".env");
export const SETTINGS_FILE = path.join(DATA_DIR, "agent-lab.settings.json");
export const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
export const USAGE_FILE = path.join(DATA_DIR, "thread-usage.json");
export const KNOWLEDGE_INBOX_FILE = path.join(DATA_DIR, "knowledge-inbox.md");

let ensured = false;

function copyIfMissing(source, target, options = {}) {
  if (!source || !existsSync(source) || existsSync(target)) return;
  mkdirSync(path.dirname(target), { recursive: true });
  if (options.recursive) cpSync(source, target, { recursive: true });
  else copyFileSync(source, target);
}

// First run after upgrading from a bundled build migrates the old local files
// once. Later launches never overwrite the user's live configuration.
export function ensureDataLayout() {
  if (ensured) return;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(CODEX_HOME, { recursive: true });

  if (USING_MANAGED_CODEX_HOME) {
    copyIfMissing(BUNDLED_CONFIG_FILE, CONFIG_FILE);
    copyIfMissing(BUNDLED_MODEL_CATALOGS, path.join(CODEX_HOME, "model-catalogs"), { recursive: true });
  }

  copyIfMissing(BUNDLED_PROJECTS_FILE, PROJECTS_FILE);
  copyIfMissing(BUNDLED_SETTINGS_FILE, SETTINGS_FILE);
  copyIfMissing(BUNDLED_ENV_FILE, ENV_FILE);
  if (existsSync(ENV_FILE)) {
    try {
      chmodSync(ENV_FILE, 0o600);
    } catch {}
  }

  ensured = true;
}
