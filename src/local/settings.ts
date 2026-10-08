// Rewrites the laptop's ~/.pi/agent/settings.json for the Sprite.
//
// pi's settings have two lists: `packages` (npm:/git: sources pi installs; entries
// are strings or objects with a `source`) and `extensions` (paths to local files).
//
// - `remote.exclude` drops entries from either list (substring match).
// - `remote.replace` swaps an entry (same matching) for another source or a file:
//   `npm:…`/`git:…` lands in `packages`, a path (`~/…` or `/…`) in `extensions`.
//   A replacement file must exist and be synced, or the sync stops with an error.
// - Local paths in either list (an extension file, or a package that is a local
//   folder) that are not synced are dropped: they would not exist there.
// - Finally every laptop home path becomes the Sprite home path.

import { join, resolve } from "node:path";
import { HOME, SPRITE_HOME } from "./paths.ts";

export interface RemoteRules {
  exclude: readonly string[];
  replace: Readonly<Record<string, string>>;
}

export interface RewriteContext {
  /** Whether a laptop path is part of the synced set. */
  isSynced: (path: string) => boolean;
  exists: (path: string) => boolean;
  expandHome: (path: string) => string;
}

export interface RewriteResult {
  settings: Record<string, unknown>;
  /** One line per entry dropped or replaced, for the sync report. */
  changes: string[];
  /** Config mistakes that must stop the sync. */
  errors: string[];
}

type PackageEntry = string | { source: string; [key: string]: unknown };

const sourceOf = (entry: PackageEntry): string => (typeof entry === "string" ? entry : entry.source);
const withSource = (entry: PackageEntry, source: string): PackageEntry =>
  typeof entry === "string" ? source : { ...entry, source };
const isPath = (value: string): boolean => value.startsWith("/") || value.startsWith("~/");

/** Absolute laptop path for a local source; relative ones resolve from the settings folder. */
function localPath(source: string): string | undefined {
  if (source.startsWith("/")) return source;
  if (source.startsWith("~/")) return join(HOME, source.slice(2));
  if (source.startsWith("./") || source.startsWith("../")) return resolve(HOME, ".pi/agent", source);
  return undefined;
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
  context: RewriteContext,
): RewriteResult {
  const changes: string[] = [];
  const errors: string[] = [];
  const packages: PackageEntry[] = [];
  const extensions: string[] = [];

  const addExtension = (path: string): void => {
    if (!extensions.includes(path)) extensions.push(path);
  };

  const place = (entry: PackageEntry, fromPackages: boolean): void => {
    const source = sourceOf(entry);
    const excluded = rules.exclude.find((pattern) => source.includes(pattern));
    if (excluded !== undefined) {
      changes.push(`dropped ${source} (remote.exclude "${excluded}")`);
      return;
    }

    const replaced = Object.entries(rules.replace).find(([pattern]) => source.includes(pattern));
    if (replaced !== undefined) {
      const replacement = replaced[1];
      if (isPath(replacement)) {
        const file = context.expandHome(replacement);
        if (!context.exists(file)) errors.push(`remote.replace: ${replacement} does not exist`);
        else if (!context.isSynced(file)) errors.push(`remote.replace: ${replacement} is not under sync.paths`);
        else {
          addExtension(file);
          changes.push(`replaced ${source} with ${replacement}`);
        }
      } else {
        packages.push(withSource(entry, replacement));
        changes.push(`replaced ${source} with ${replacement}`);
      }
      return;
    }

    // Local paths, in either list, must be synced: pi loads them in place and does not
    // copy them (a package can be a local folder, `pi install ./dir`).
    const local = localPath(source);
    if (local !== undefined && !context.isSynced(local)) {
      changes.push(`dropped ${source} (not under sync.paths)`);
      return;
    }
    if (fromPackages) packages.push(local === undefined ? entry : withSource(entry, local));
    else addExtension(local ?? source);
  };

  if (Array.isArray(settings.packages)) for (const entry of settings.packages as PackageEntry[]) place(entry, true);
  if (Array.isArray(settings.extensions)) for (const entry of settings.extensions as string[]) place(entry, false);

  const out: Record<string, unknown> = { ...settings };
  if (Array.isArray(settings.packages) || packages.length > 0) out.packages = packages;
  if (Array.isArray(settings.extensions) || extensions.length > 0) out.extensions = extensions;

  // settings.json is parsed JSON, so every value is a Json value.
  return { settings: mapHomePaths(out as Json) as Record<string, unknown>, changes, errors };
}
