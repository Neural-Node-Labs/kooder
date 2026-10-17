// xcoder:version 12 | xcoder:task task-a3052a | xcoder:updated 2026-10-17T13:01:13.719Z | xcoder:subtask code-st-b3a0c8
// LLM config — per-role provider configuration (design: llm-provider-config)
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import os from "node:os";
import { log } from "../util/logger.js";
import { createKooderPaths } from "../util/kooder-paths.js";
import { readKooderEnv } from "./env.js";
import { applyUserConfig, getActiveUserConfig } from "./user-config.js";

// ============================================================================
// Environment Initialization (Must run before reading process.env)
// ============================================================================
/**
 * Directory the app runs from. Under `bun build --compile` modules live in a
 * virtual filesystem (`/$bunfs/…`, `B:\~BUN\…`), so use the folder that holds
 * the executable instead — that is where the installer puts `skills/`.
 */
function getAppDir(): string {
  const dir = typeof import.meta !== "undefined" && import.meta.dirname
    ? import.meta.dirname
    : __dirname;
  return dir.includes("$bunfs") || dir.includes("~BUN") ? path.dirname(process.execPath) : dir;
}

function loadKooderEnv(): void {
  const envCandidates: string[] = [];

  // 1. App directory (where the kooder executable / app bundle lives)
  const appDir = getAppDir();
  envCandidates.push(path.join(appDir, ".env"));

  // 2. KOODER_HOME directory (if defined)
  const kooderHome = readKooderEnv("KOODER_HOME");
  if (kooderHome) {
    envCandidates.push(path.join(kooderHome, ".env"));
  }

  // 3. User's global home directory (~/.kooder/.env)
  const globalKooderDir = path.join(os.homedir(), ".kooder");
  envCandidates.push(path.join(globalKooderDir, ".env"));

  // Ensure the global ~/.kooder directory exists for users
  if (!fs.existsSync(globalKooderDir)) {
    fs.mkdirSync(globalKooderDir, { recursive: true });
  }

  // Load global/system candidate .env files first
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
    }
  }

  // 4. Current working directory .env (highest priority local overrides)
  const cwdEnvPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(cwdEnvPath)) {
    dotenv.config({ path: cwdEnvPath, override: true });
  }
}

// Execute environment loader immediately on module load
loadKooderEnv();

// ~/.kooder/config.json (provider / key / model / base_url / env) — beats .env files, loses to the real shell env.
applyUserConfig();

// Back-compat: accept legacy RONIN_* variables from before the rebrand.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("RONIN_")) {
    const renamed = `XCODER_${key.slice("RONIN_".length)}`;
    if (process.env[renamed] === undefined) process.env[renamed] = value;
  }
}

// ============================================================================
// Types & Config Definitions
// ============================================================================
export type LlmProvider = "deepseek" | "openai-compatible" | "anthropic";

export type AgentRole = "orchestrator" | "sub_agent" | "swarm_agent" | "instance_agent";

export interface LlmConfig {
  provider: LlmProvider;
  base_url?: string; // SDK base URL (OpenAI-compatible / Anthropic-compatible endpoint)
  endpoint?: string; // e.g. "/chat/completions" — default when unset for OpenAI-compatible
  model: string;
  api_key_env?: string; // env var NAME; omit for keyless local providers (Ollama)
  max_tokens: number;
  temperature: number;
  thinking?: boolean;
  reasoning_effort?: "high" | "max"; // only meaningful when thinking is enabled
  overrides?: Record<string, { model?: string; temperature?: number; thinking?: boolean; reasoning_effort?: "high" | "max" }>;
  fallback?: Partial<LlmConfig>;
}

/**
 * YAML schema of `.xcoder/config/llm.yaml`. The `default` block is the
 * global fallback; each role block (`orchestrator`, `sub_agent`,
 * `swarm_agent`, `instance_agent`) overrides it for that agent role.
 */
export interface LlmConfigFile {
  default?: LlmConfig;
  orchestrator?: LlmConfig;
  sub_agent?: LlmConfig;
  swarm_agent?: LlmConfig;
  instance_agent?: LlmConfig;
}

export const AGENT_ROLES: AgentRole[] = [
  "orchestrator",
  "sub_agent",
  "swarm_agent",
  "instance_agent",
];

const RELATIVE_CONFIG_PATH = ".kooder/config/llm.yaml";
const RELATIVE_HOME_PATH = path.join("./");
const RELATIVE_AGENT_PATH = ".kooder";

/**
 * Shared candidate-path resolution used by resolveSkillsPath, resolveConfigPath,
 * and resolveAgentPath. Checks, in order:
 *   1. App directory (where this source file/code is running from)
 *   2. KOODER_HOME env variable (if set)
 *   3. Current working directory
 *   4. User's home directory
 * Returns the first candidate that exists on disk, or the app-directory
 * candidate as a fallback if none exist (so callers always get a usable
 * default path even when nothing has been created yet).
 *
 * Set KOODER_DEBUG_CONFIG_PATH=1 to log which candidate was selected.
 */
function resolveFirstExisting(relativePath: string): string {
  const appDir = getAppDir();

  const candidatePaths: string[] = [path.join(appDir, relativePath)];

  const kooderHome = readKooderEnv("KOODER_HOME");
  if (kooderHome) {
    candidatePaths.push(path.join(kooderHome, relativePath));
  }

  candidatePaths.push(path.join(process.cwd(), relativePath));
  candidatePaths.push(path.join(os.homedir(), relativePath));

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      if (readKooderEnv("KOODER_DEBUG_CONFIG_PATH")) {
        log.dim(`configPath: ${candidate}`);
      }
      return candidate;
    }
  }

  // Nothing found anywhere — fall back to the app-directory candidate so
  // downstream code (e.g. loadLlmConfig) still gets a deterministic path
  // and applies its own defaults.
  return candidatePaths[0] ?? path.join(process.cwd(), RELATIVE_CONFIG_PATH);
}

/**
 * Returns a directory D such that `D/skills` exists. Looks next to the
 * executable (installer), then up from the module location (npm `dist/`,
 * source checkout), then KOODER_HOME, ~/.kooder and finally the cwd.
 */
export function resolveSkillsPath(): string {
  const appDir = getAppDir();
  const exeDir = path.dirname(process.execPath);
  const kooderHomePath = readKooderEnv("KOODER_HOME");
  const roots: string[] = [
    appDir,
    path.join(exeDir, "..", "share", "kooder"), // .deb / macOS installer / tar install.sh
    path.join(appDir, ".."),
    path.join(appDir, "..", ".."),
    ...(kooderHomePath ? [kooderHomePath] : []),
    path.join(os.homedir(), ".kooder"),
    process.cwd(),
  ];
  for (const root of roots) {
    if (fs.existsSync(path.join(root, "skills"))) {
      if (readKooderEnv("KOODER_DEBUG_CONFIG_PATH")) log.dim(`skillsPath: ${root}`);
      return root;
    }
  }
  return roots[0];
}

export function resolveConfigPath(): string {
  return resolveFirstExisting(RELATIVE_HOME_PATH);
}

export function resolveAgentPath(): string {
  return resolveFirstExisting(RELATIVE_AGENT_PATH);
}

/**
 * Built-in DeepSeek default — used when no config file exists and as the
 * fallback for every role. Reads KOODER_MODEL lazily so env changes between
 * calls are honored.
 *
 * Provider `deepseek` is served through DeepSeek's Anthropic-compatible
 * endpoint (`@anthropic-ai/sdk`, which appends `/v1/messages` to the base
 * URL), so the canonical root is `https://api.deepseek.com/anthropic` —
 * NOT the OpenAI-compatible `https://api.deepseek.com/v1`, which would
 * produce the invalid `.../v1/v1/messages` request path.
 */
export function deepseekDefaultConfig(): LlmConfig {
  return {
    provider: "deepseek",
    base_url: "https://api.deepseek.com/anthropic",
    model: readKooderEnv("KOODER_MODEL") ?? "deepseek-chat",
    api_key_env: "DEEPSEEK_API_KEY",
    max_tokens: 16384,
    temperature: 0.0,
    thinking: false,
  };
}

/**
 * Read `.kooder/config/llm.yaml` and return the raw per-role schema.
 * Merge happens in `resolveLlmConfig`, not here. A legacy file shaped as a
 * single provider block is interpreted as the `default` block.
 */
export function loadLlmConfigFile(configPath?: string): LlmConfigFile {
  const resolved = configPath ?? createKooderPaths(process.cwd()).llmConfigPath();
  if (!fs.existsSync(resolved)) {
    return {};
  }
  const raw: unknown = yaml.load(fs.readFileSync(resolved, "utf-8"));
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  // New per-role schema wins even when the file also carries legacy
  // top-level keys (e.g. a partially migrated file with both a legacy
  // `provider:` block and `default`/role blocks). Treating such a file as
  // a single legacy `default` block silently discards every role block.
  if (
    "default" in obj ||
    AGENT_ROLES.some((role) => obj[role] && typeof obj[role] === "object")
  ) {
    return obj as unknown as LlmConfigFile;
  }
  if ("provider" in obj || "model" in obj) {
    return { default: obj as unknown as LlmConfig };
  }
  return obj as unknown as LlmConfigFile;
}

/**
 * Resolve the effective LLM config for a role.
 * Precedence: role block → `default` block → built-in DeepSeek default.
 * `XCODER_MODEL` is applied as an env override for `model` only.
 */
const PROVIDER_DEFAULTS: Record<LlmProvider, { base_url?: string; model?: string }> = {
  deepseek: { base_url: "https://api.deepseek.com/anthropic", model: "deepseek-chat" },
  anthropic: {},
  "openai-compatible": {},
};

/**
 * Overlay `~/.xcoder/config.json` (provider / key / model / base_url) on a
 * resolved block. Switching provider also resets base_url to that provider's
 * default, so a key is never sent to the previous provider's host.
 */
export function applyUserLlmOverrides(cfg: LlmConfig): LlmConfig {
  const uc = getActiveUserConfig();
  if (!uc.provider && !uc.key && !uc.model && !uc.base_url) return cfg;
  const out: LlmConfig = { ...cfg };
  if (uc.provider && uc.provider !== cfg.provider) {
    out.provider = uc.provider;
    out.base_url = PROVIDER_DEFAULTS[uc.provider].base_url;
    out.endpoint = undefined;
    if (!uc.model && PROVIDER_DEFAULTS[uc.provider].model) out.model = PROVIDER_DEFAULTS[uc.provider].model as string;
  }
  if (uc.base_url) out.base_url = uc.base_url;
  if (uc.model) out.model = uc.model;
  if (uc.key) out.api_key_env = "KOODER_API_KEY";
  return out;
}

export function resolveLlmConfig(role: AgentRole, file?: LlmConfigFile): LlmConfig {
  const selected = applyUserLlmOverrides((file && (file[role] ?? file.default)) ?? deepseekDefaultConfig());
  const envModel = readKooderEnv("KOODER_MODEL");
  return {
    ...selected,
    provider: selected.provider ?? "deepseek",
    model: envModel ?? selected.model ?? "deepseek-chat",
    max_tokens: selected.max_tokens ?? 16384,
    temperature: selected.temperature ?? 0.0,
    api_key_env: selected.api_key_env ?? "DEEPSEEK_API_KEY",
  };
}

/**
 * @deprecated Legacy loader — returns the merged `default` block. New code
 * should use `loadLlmConfigFile()` + `resolveLlmConfig(role, file)`.
 */
export function loadLlmConfig(configPath?: string): LlmConfig {
  const file = loadLlmConfigFile(configPath);
  const block = applyUserLlmOverrides(file.default ?? deepseekDefaultConfig());
  const envModel = readKooderEnv("KOODER_MODEL");
  return {
    ...block,
    provider: block.provider ?? "deepseek",
    model: envModel ?? block.model ?? "deepseek-chat",
    max_tokens: block.max_tokens ?? 16384,
    temperature: block.temperature ?? 0.0,
    api_key_env: block.api_key_env ?? "DEEPSEEK_API_KEY",
  };
}

export function resolveModelForSkill(config: LlmConfig, skillName?: string) {
  const override = skillName ? config.overrides?.[skillName] : undefined;
  return {
    model: override?.model ?? config.model,
    temperature: override?.temperature ?? config.temperature,
    thinking: override?.thinking ?? config.thinking ?? false,
    reasoningEffort: override?.reasoning_effort ?? config.reasoning_effort,
  };
}