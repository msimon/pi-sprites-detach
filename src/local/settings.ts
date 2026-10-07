// Rewrites the laptop's ~/.pi/agent/settings.json for the Sprite.
//
// pi's settings have two lists: `packages` (npm:/git: sources pi installs; entries
// are strings or objects with a `source`) and `extensions` (paths to local files).
// `remote.exclude` drops entries from either list, `remote.replace` swaps them, and
// extension paths that are not synced are dropped because they would not exist there.
// Finally every laptop home path becomes the Sprite home path.

import { HOME, SPRITE_HOME } from "./paths.ts";

export interface RemoteRules {
  exclude: readonly string[];
  replace: Readonly<Record<string, string>>;
}

export interface RewriteResult {
  settings: Record<string, unknown>;
  /** One line per entry dropped or replaced, for the sync report. */
  changes: string[];
}

type PackageEntry = string | { source: string; [key: string]: unknown };

function sourceOf(entry: PackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function withSource(entry: PackageEntry, source: string): PackageEntry {
  return typeof entry === "string" ? source : { ...entry, source };
}

/** Apply exclude and replace to one entry: the new entry, or undefined to drop it. */
function applyRules<T extends PackageEntry>(entry: T, rules: RemoteRules, changes: string[]): T | undefined {
  const source = sourceOf(entry);
  const excluded = rules.exclude.find((pattern) => source.includes(pattern));
  if (excluded !== undefined) {
    changes.push(`dropped ${source} (remote.exclude "${excluded}")`);
    return undefined;
  }
  for (const [pattern, replacement] of Object.entries(rules.replace)) {
    if (!source.includes(pattern)) continue;
    if (replacement.startsWith("builtin:")) {
      changes.push(`dropped ${source} (provided by pi-handoff as ${replacement})`);
      return undefined;
    }
    changes.push(`replaced ${source} with ${replacement}`);
    return withSource(entry, replacement) as T;
  }
  return entry;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function mapHomePaths(value: Json): Json {
  if (typeof value === "string") {
    return value === HOME || value.startsWith(`${HOME}/`) ? SPRITE_HOME + value.slice(HOME.length) : value;
  }
  if (Array.isArray(value)) return value.map(mapHomePaths);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapHomePaths(v)]));
  }
  return value;
}

export function rewriteSettings(
  settings: Record<string, unknown>,
  rules: RemoteRules,
  /** Whether a laptop path is part of the synced set. */
  isSynced: (path: string) => boolean,
): RewriteResult {
  const changes: string[] = [];
  const out: Record<string, unknown> = { ...settings };

  if (Array.isArray(settings.packages)) {
    out.packages = (settings.packages as PackageEntry[])
      .map((entry) => applyRules(entry, rules, changes))
      .filter((entry) => entry !== undefined);
  }

  if (Array.isArray(settings.extensions)) {
    out.extensions = (settings.extensions as string[])
      .map((entry) => applyRules(entry, rules, changes))
      .filter((entry): entry is string => {
        if (entry === undefined) return false;
        // Package sources (npm:, git:) are installed by pi; local paths must be synced.
        if (!entry.startsWith("/") || isSynced(entry)) return true;
        changes.push(`dropped ${entry} (not under sync.paths)`);
        return false;
      });
  }

  // settings.json is parsed JSON, so every value is a Json value.
  return { settings: mapHomePaths(out as Json) as Record<string, unknown>, changes };
}
