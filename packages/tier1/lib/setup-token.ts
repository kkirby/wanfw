import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// wanfw_status is mounted read-only into tier1 (docker-compose.yml,
// `wanfw_status:/data/status:ro`) -- the same volume the orchestrator's
// status socket serves from, but this one file is read directly off disk
// rather than through the socket, since it's written once by `wanfwctl
// init` (T5.3) and never changes after that.
const STATUS_DIR = process.env.WANFW_STATUS_DIR ?? "/data/status";
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h (docs/t5.3-decisions.md)

interface SetupTokenFile {
  token: string;
  createdAt: string;
}

/**
 * The one-time setup token `wanfwctl init` writes (docs/t5.3-decisions.md,
 * Decision 2) -- gates the first-run `/setup` page so the admin account
 * can only be claimed by whoever ran init on the host, not the first
 * person on the LAN to reach tier1:8443. Expired or missing is the same
 * as "no token": the setup page tells the operator to (re-)run
 * `wanfwctl init`.
 */
export async function verifySetupToken(candidate: string): Promise<boolean> {
  let file: SetupTokenFile;
  try {
    file = JSON.parse(await readFile(join(STATUS_DIR, "setup-token.json"), "utf8")) as SetupTokenFile;
  } catch {
    return false;
  }
  if (!file.token || candidate !== file.token) return false;
  const age = Date.now() - new Date(file.createdAt).getTime();
  return age >= 0 && age <= TOKEN_TTL_MS;
}
