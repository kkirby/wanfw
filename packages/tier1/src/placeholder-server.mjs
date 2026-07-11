// Placeholder entrypoint (T0.3). Real Next.js app (App Router, Mantine,
// login, dashboard) lands in T1.4. This just proves the image boots, stays
// up, and serves an HTTP response on the LAN port.
import { createServer } from "node:http";

const port = process.env.PORT ? Number(process.env.PORT) : 8443;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("wanfw tier1 placeholder (T1.4 will replace this with the Next.js app)\n");
});

server.listen(port, () => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "tier1", level: "info", msg: "placeholder listening", port })}\n`);
});

function shutdown(signal) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "tier1", level: "info", msg: "shutting down", signal })}\n`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
