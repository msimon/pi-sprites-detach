// Desktop notification in the cmux pane that started the job (S6).

import { existsSync } from "node:fs";
import { run } from "./exec.ts";

const CMUX_APP_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";

/** Post to a cmux surface. Returns false if cmux is missing or the pane is gone (`not_found`). */
export async function cmuxNotify(surface: string, title: string, body: string): Promise<boolean> {
  const bin = existsSync(CMUX_APP_BIN) ? CMUX_APP_BIN : "cmux";
  try {
    const result = await run(bin, ["notify", "--surface", surface, "--title", title, "--body", body], {
      timeoutMs: 10_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}
