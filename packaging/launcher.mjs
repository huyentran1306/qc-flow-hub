// QA Flow Hub launcher: starts the bundled server with the bundled Node and opens the browser.
// Everything the tool stores (database, secret key) lives in the "data" folder next to this file.
import { spawn, exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(root, "app");
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const secretFile = path.join(dataDir, "app-secret.txt");
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, randomBytes(48).toString("base64"), { mode: 0o600 });
const secret = fs.readFileSync(secretFile, "utf8").trim();

const share = (process.env.QFH_SHARE ?? "").trim() === "1";
const host = share ? "0.0.0.0" : "127.0.0.1";

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + 50) return reject(new Error("Không tìm được cổng trống"));
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, host);
    };
    tryPort(start);
  });
}

const port = await freePort(Number(process.env.QFH_PORT || 3000));
const url = `http://localhost:${port}`;

const child = spawn(process.execPath, [path.join(appDir, "server.js")], {
  cwd: appDir,
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: host,
    APP_SECRET: secret,
    APP_URL: url,
    PGLITE_DIR: path.join(dataDir, "pglite"),
    UPLOAD_DIR: path.join(dataDir, "uploads"),
    QFH_PACKAGE_ROOT: root,
  },
});

const stop = () => {
  if (!child.killed) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  console.log(`\nQA Flow Hub đã dừng (mã ${code}).`);
  process.exit(code ?? 0);
});

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/login`, { redirect: "manual" });
    if (r.status < 500) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log("\n==============================================");
console.log(`  QA Flow Hub đang chạy: ${url}`);
if (share) console.log("  Đang chia sẻ trong mạng LAN: người khác mở http://<IP máy này>:" + port);
console.log(`  Dữ liệu lưu tại: ${dataDir}`);
console.log("  Muốn tắt: đóng cửa sổ này (hoặc bấm Ctrl+C).");
console.log("==============================================\n");

if ((process.env.QFH_NO_BROWSER ?? "").trim() !== "1") {
  const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}
