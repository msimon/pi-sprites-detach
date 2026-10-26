// When a joined pi (/attach) quits on its own: once the agent is idle and nobody
// is attached to its tmux session, on two checks in a row (so a quick reconnect, or
// a message queued during a turn that starts the next one right after agent_end, does
// not count). Before anyone has attached at all, pi waits up to START_GRACE_MS for the
// laptop's terminal to attach before giving up.

export const CHECK_MS = 5_000;
export const START_GRACE_MS = 120_000;

export interface IdleCheck {
  /** A turn is in progress (between agent_start and agent_end). */
  busy: boolean;
  /** Clients attached to the tmux session now; undefined when tmux could not tell. */
  clients: number | undefined;
  /** Milliseconds since this pi started. */
  sinceStart: number;
}

export class IdleRule {
  #seenClient = false;
  #strikes = 0;

  /** Whether pi should quit now. Call every CHECK_MS. */
  check({ busy, clients, sinceStart }: IdleCheck): boolean {
    // tmux unreachable: never quit on a guess.
    if (clients === undefined) {
      this.#strikes = 0;
      return false;
    }
    if (clients > 0) this.#seenClient = true;
    const unattended = clients === 0 && (this.#seenClient || sinceStart >= START_GRACE_MS);
    this.#strikes = !busy && unattended ? this.#strikes + 1 : 0;
    return this.#strikes >= 2;
  }
}

/** Clients in `tmux list-clients` output, one per line. */
export function countClients(output: string): number {
  return output.split("\n").filter((line) => line.trim() !== "").length;
}
