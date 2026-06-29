// Dev launcher. Picks a guaranteed-free port for the API server BEFORE starting
// anything, then hands that port to both the server (PORT) and the client's Vite
// proxy (API_PORT). Vite picks its own free UI port (it auto-increments). The
// browser talks to the server through Vite's same-origin /ws proxy, so no port is
// ever hardcoded in browser code.

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_API_PORT = Number(process.env.PORT ?? 8787);

/** Resolve the first free TCP port at or after `start`. */
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        resolve(findFreePort(start + 1));
      } else {
        reject(err);
      }
    });
    srv.listen(start, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const colors = { server: "\x1b[35m", client: "\x1b[36m", reset: "\x1b[0m" };

function run(name, args, env) {
  const child = spawn("pnpm", args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = `${colors[name] ?? ""}[${name}]${colors.reset} `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(tag + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

const apiPort = await findFreePort(DEFAULT_API_PORT);
if (apiPort !== DEFAULT_API_PORT) {
  console.log(`[dev] port ${DEFAULT_API_PORT} busy — using ${apiPort} for the API server`);
}

const server = run("server", ["--filter", "@review-table/server", "dev"], {
  PORT: String(apiPort),
});
const client = run("client", ["--filter", "@review-table/client", "dev"], {
  API_PORT: String(apiPort),
});

const children = [server, client];
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
for (const c of children) {
  c.on("exit", (code) => {
    // If either process dies, take the whole dev session down so failures are obvious.
    if (!shuttingDown) {
      console.log(`[dev] ${c === server ? "server" : "client"} exited (${code}); stopping.`);
      shutdown();
      process.exit(code ?? 1);
    }
  });
}
