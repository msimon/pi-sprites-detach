// ~/.pi-sprites-detach/config.json. The first run writes the defaults, so everything that
// syncs or is skipped is visible and editable in one file.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_FILE, PACKAGE_ROOT, USER_EXTENSIONS_DIR } from "./paths.ts";

/** Example user extensions the default config refers to. */
const EXAMPLES = ["remote-ask.ts"];

async function installExamples(): Promise<void> {
  await mkdir(USER_EXTENSIONS_DIR, { recursive: true });
  for (const name of EXAMPLES) {
    try {
      // COPYFILE_EXCL: an existing file is Marc's and stays as it is.
      await copyFile(join(PACKAGE_ROOT, "examples", name), join(USER_EXTENSIONS_DIR, name), 1);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export interface DetachConfig {
  /** Sprite for new jobs; each job records its own. */
  sprite: string;
  /**
   * Whether the remote agent opens a pull request when the work is ready. With "never"
   * (the default) the work comes back by pull, which fast-forwards the local branch.
   */
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
    /**
     * Same matching, swapped for another source: `npm:…`, `git:…`, or a file of your
     * own (`~/…`), which must be under sync.paths, e.g. in ~/.pi-sprites-detach/extensions/.
     */
    replace: Record<string, string>;
    /** Programs an extension needs that pi does not install, kept at the laptop's version. */
    tools: string[];
  };
  /** Git-ignored project files copied into the job's checkout. */
  copyProjectFiles: string[];
}

export const DEFAULT_CONFIG: DetachConfig = {
  sprite: "pi-handoff",
  pr: "never",
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
      "~/.pi-sprites-detach/extensions",
    ],
    exclude: ["**/.venv", "**/node_modules", "**/__pycache__", "**/.DS_Store", "**/*.lock"],
  },
  remote: {
    // pi-sprites-detach's own laptop extension: as a package (git:github.com/msimon/pi-sprites-detach)
    // it is excluded here; loaded from a repo path it is outside sync.paths anyway.
    exclude: ["msimon/pi-sprites-detach"],
    // Does nothing unless that package is installed; it hides its tool without a UI (S3).
    replace: { "npm:@juicesharp/rpiv-ask-user-question": "~/.pi-sprites-detach/extensions/remote-ask.ts" },
    // Filled in by the setup prompt, from the recipes the laptop has the tool for.
    tools: [],
  },
  copyProjectFiles: [".env*", ".scratch/"],
};

export interface LoadedConfig {
  config: DetachConfig;
  /** Set when the file was created on this load. */
  created: boolean;
}

/**
 * Read the config. On first run, write the defaults and copy the example user
 * extensions they refer to into ~/.pi-sprites-detach/extensions/ (never overwriting); from
 * then on both are Marc's to edit. Missing keys take the defaults.
 */
export async function loadConfig(): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(CONFIG_FILE, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    await installExamples();
    return { config: structuredClone(DEFAULT_CONFIG), created: true };
  }

  let raw: Partial<DetachConfig>;
  try {
    raw = JSON.parse(text) as Partial<DetachConfig>;
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

/**
 * `copyProjectFiles` for a repo: `<repo>/.pi-sprites-detach.json` overrides the config
 * (`.pi-handoff.json`, the name before the rename, still works when the new one is absent).
 */
export async function projectFilePatterns(repoRoot: string, config: DetachConfig): Promise<string[]> {
  let file = join(repoRoot, ".pi-sprites-detach.json");
  let text: string | undefined;
  for (const name of [".pi-sprites-detach.json", ".pi-handoff.json"]) {
    try {
      text = await readFile(join(repoRoot, name), "utf8");
      file = join(repoRoot, name);
      break;
    } catch {
      // Not there: the next name, then the config.
    }
  }
  if (text === undefined) return config.copyProjectFiles;
  try {
    const project = JSON.parse(text) as { copyProjectFiles?: unknown };
    if (Array.isArray(project.copyProjectFiles)) return project.copyProjectFiles.map(String);
  } catch (error: unknown) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return config.copyProjectFiles;
}
