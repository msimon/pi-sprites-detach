// Minimal globs for `sync.exclude`, matched against paths relative to the home folder.
//
// - `*` matches within one path segment, `?` one character, `**` any number of segments.
// - A pattern without `/` matches a name at any depth (`.venv` is `**/.venv`).
// - `~/` anchors a pattern at the home folder.
// - A match on a folder excludes everything under it.

// Patterns come from Marc's own config file, so the built regexes are trusted input.
function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\/+$/, "");
  if (p.startsWith("~/")) p = p.slice(2);
  else if (!p.includes("/")) p = `**/${p}`;

  let source = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") {
      source += "[^/]*";
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function createMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const regexes = patterns.map(globToRegExp);
  return (relativePath) => {
    // A path is excluded if it, or any folder above it, matches.
    const parts = relativePath.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join("/");
      if (regexes.some((r) => r.test(prefix))) return true;
    }
    return false;
  };
}
