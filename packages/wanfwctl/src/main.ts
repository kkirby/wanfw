import { runCli } from "./cli.js";
import { WANFW_SOCKET_PATHS } from "@wanfw/core-schemas";

const adminSocketPath = process.env.WANFW_ADMIN_SOCKET_PATH ?? WANFW_SOCKET_PATHS.admin;

const exitCode = await runCli(process.argv.slice(2), {
  adminSocketPath,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});

process.exit(exitCode);
