import { spawn } from "node:child_process";
import process from "node:process";

const children = [];
let shuttingDown = false;

function launch(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode == null) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 120);
}

const server = launch("npm", ["run", "dev:server"]);
const client = launch("npm", ["run", "dev:client"]);

server.on("exit", (code) => shutdown(code ?? 0));
client.on("exit", (code) => shutdown(code ?? 0));

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
