// M1 echo test fixture (spec §15 M1 acceptance). Hand-written NDJSON
// JSON-RPC client -- deliberately not using @wanfw/plugin-sdk so this
// fixture has zero build step and can be staged/tampered with directly as
// raw bytes by the integration harness.
process.stdin.setEncoding("utf8");

let nextId = 1;
const pending = new Map();
let buf = "";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function callHost(method, args) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: "host.call", params: { method, args } });
  });
}

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);

    if (msg.method && msg.id) {
      handleTask(msg.method, msg.params, msg.id);
      continue;
    }
    // response to one of our own host.call requests
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }
});

async function handleTask(task, params, id) {
  try {
    let result;
    if (task === "echo") {
      result = params;
    } else if (task === "sleep") {
      await new Promise(() => {}); // never resolves; exercises the wallMs timeout
    } else if (task === "attemptSecretsRead") {
      try {
        await callHost("secrets.read", { name: "not-granted" });
        result = { rejected: false };
      } catch (err) {
        result = { rejected: true, message: err.message };
      }
    } else {
      throw new Error(`unknown task: ${task}`);
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
  }
}
