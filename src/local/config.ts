// ~/.pi-handoff/config.json. The first run writes the defaults, so everything that
// syncs or is skipped is visible and editable in one file.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_FILE } from "./paths.ts";

export interface HandoffConfig {
  /** Sprite for new jobs; each job records its own. */
  sprite: string;
  /** Whether the remote agent opens a pull request when the work is ready. */
  pr: "auto" | "never";
  sync: {
    /** Exactly what Config sync sends (settings.json always syncs, rewritten). */
    paths: string[];
    /** Globs skipped inside those paths. No slash: matches a name at any depth. */
    exclude: string[];
  };
  remote: {
    /** Packages or extension paths not loaded on the Sprite (substring match). */
    exclude: string[];
    /** Same matching, swapped for another source; `builtin:` ones come with pi-handoff. */
    replace: Record<string, string>;
    /** Programs an extension needs that pi does not install, kept at the laptop's version. */
    tools: string[];
  };
  /** Git-ignored project files copied into the job's checkout. */
  copyProjectFiles: string[];
}

export const DEFAULT_CONFIG: HandoffConfig = {
  sprite: "pi-handoff",
  pr: "auto",
  sync: {
    paths: [
      "~/.pi/agent/AGENTS.md",
      "~/.pi/agent/extensions",
      "~/.pi/agent/skills",
      "~/.pi/agent/loadouts.json",
      "~/.pi/agent/subagents.json",
      "~/.pi/agent/trust.json",
      "~/.agents/skills",
      "~/.pi/web-search.json",
    ],
    exclude: ["**/.venv", "**/node_modules", "**/__pycache__", "**/.DS_Store", "**/*.lock"],
  },
  remote: {
    exclude: ["pi-handoff", "pi-cron-jobs", "pi-reminders"],
    replace: { "npm:@juicesharp/rpiv-ask-user-question": "builtin:remote-ask" },
    tools: ["agent-browser"],
  },
  copyProjectFiles: [".env*", ".scratch/"],
};

export interface LoadedConfig {
  config: HandoffConfig;
  /** Set when the file was created on this load. */
  created: boolean;
}

/** Read the config, writing the defaults first if there is none. Missing keys take the defaults. */
export async function loadConfig(): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(CONFIG_FILE, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return { config: structuredClone(DEFAULT_CONFIG), created: true };
  }

  let raw: Partial<HandoffConfig>;
  try {
    raw = JSON.parse(text) as Partial<HandoffConfig>;
  } catch (error: unknown) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const d = DEFAULT_CONFIG;
  return {
    config: {
      sprite: raw.sprite ?? d.sprite,
      pr: raw.pr ?? d.pr,
      sync: { ...d.sync, ...raw.sync },
      remote: { ...d.remote, ...raw.remote },
      copyProjectFiles: raw.copyProjectFiles ?? d.copyProjectFiles,
    },
    created: false,
  };
}

/** `copyProjectFiles` for a repo: `<repo>/.pi-handoff.json` overrides the config. */
export async function projectFilePatterns(repoRoot: string, config: HandoffConfig): Promise<string[]> {
  const file = join(repoRoot, ".pi-handoff.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return config.copyProjectFiles;
  }
  try {
    const project = JSON.parse(text) as { copyProjectFiles?: unknown };
    if (Array.isArray(project.copyProjectFiles)) return project.copyProjectFiles.map(String);
  } catch (error: unknown) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return config.copyProjectFiles;
}
