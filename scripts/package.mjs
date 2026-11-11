// Builds double-click packages: dist/QA-Flow-Hub-<target>.zip
// Usage: npm run package                 (mac-arm64 + win-x64)
//        npm run package -- mac-x64      (Intel Mac)
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareStandalone } from "./prepare-standalone.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = path.join(root, "dist");
const cache = path.join(dist, ".cache");
const DIST_DIR = ".next-pack";
const NODE_VERSION = process.env.QFH_NODE_VERSION || process.version; // e.g. v24.12.0
const targets = (process.argv[2] || "mac-arm64,mac-x64,win-x64").split(",").map((t) => t.trim());

const NODE_DIST = {
  "mac-arm64": { file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, bin: "bin/node", out: "node" },
  "mac-x64": { file: `node-${NODE_VERSION}-darwin-x64.tar.gz`, bin: "bin/node", out: "node" },
  "win-x64": { file: `node-${NODE_VERSION}-win-x64.zip`, bin: "node.exe", out: "node.exe" },
};

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tải ${url} lỗi HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function nodeRuntime(target) {
  const spec = NODE_DIST[target];
  if (!spec) throw new Error(`Không hỗ trợ target ${target}. Chọn: ${Object.keys(NODE_DIST).join(", ")}`);
  fs.mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  await download(`${base}/SHASUMS256.txt`, sums);
  const archive = path.join(cache, spec.file);
  await download(`${base}/${spec.file}`, archive);
  const expected = fs.readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${spec.file}`))?.split(" ")[0];
  const actual = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (!expected || expected !== actual) {
    rm(archive);
    throw new Error(`Checksum của ${spec.file} không khớp, đã xoá file tải về. Chạy lại.`);
  }
  const extractDir = path.join(cache, spec.file.replace(/\.(tar\.gz|zip)$/, ""));
  if (!fs.existsSync(extractDir)) {
    if (spec.file.endsWith(".zip")) execFileSync("unzip", ["-q", archive, "-d", cache]);
    else execFileSync("tar", ["-xzf", archive, "-C", cache]);
  }
  return { bin: path.join(extractDir, spec.bin), out: spec.out };
}

execSync("node scripts/build-guide.mjs", { cwd: root, stdio: "inherit" });
console.log(`Build production (${DIST_DIR})…`);
rm(path.join(root, DIST_DIR));
execSync("npx next build", { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_DIST_DIR: DIST_DIR } });

for (const target of targets) {
  const name = `QA-Flow-Hub-${target}`;
  const stage = path.join(dist, name);
  console.log(`\nĐóng gói ${name}…`);
  rm(stage);
  fs.mkdirSync(stage, { recursive: true });
  const app = path.join(stage, "app");
  const fixed = prepareStandalone(root, DIST_DIR, app);
  if (fixed) console.log(`  thay ${fixed} symlink bằng bản copy thật`);

  const rt = await nodeRuntime(target);
  fs.mkdirSync(path.join(stage, "runtime"));
  fs.copyFileSync(rt.bin, path.join(stage, "runtime", rt.out));
  fs.chmodSync(path.join(stage, "runtime", rt.out), 0o755);
  fs.copyFileSync(path.join(root, "packaging", "launcher.mjs"), path.join(stage, "launcher.mjs"));
  fs.copyFileSync(path.join(root, "public", "mcp-stdio.mjs"), path.join(stage, "mcp-stdio.mjs"));
  fs.copyFileSync(path.join(root, "packaging", "HUONG-DAN.txt"), path.join(stage, "HUONG-DAN.txt"));
  fs.copyFileSync(path.join(root, "docs", "HUONG-DAN-SU-DUNG.html"), path.join(stage, "HUONG-DAN-SU-DUNG.html"));
  if (target.startsWith("mac")) {
    fs.copyFileSync(path.join(root, "packaging", "start-mac.command"), path.join(stage, "start-mac.command"));
    fs.chmodSync(path.join(stage, "start-mac.command"), 0o755);
  } else {
    const bat = fs.readFileSync(path.join(root, "packaging", "start-windows.bat"), "utf8").replace(/\r?\n/g, "\r\n");
    fs.writeFileSync(path.join(stage, "start-windows.bat"), bat);
  }

  const zip = path.join(dist, `${name}.zip`);
  rm(zip);
  execFileSync("ditto", ["-c", "-k", "--keepParent", stage, zip]);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(0);
  console.log(`✓ ${zip} (${mb} MB)`);
}
