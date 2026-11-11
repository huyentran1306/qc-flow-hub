// Turns Next's standalone output into a self-contained folder that runs anywhere:
// copies static files, migrations and PGlite, and replaces build-machine symlinks with real copies.
// Usage: node scripts/prepare-standalone.mjs <distDir> <outDir>
import fs from "node:fs";
import path from "node:path";

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const cp = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true });

export function prepareStandalone(root, distDir, out) {
  const standalone = path.join(root, distDir, "standalone");
  if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error(`Không thấy ${standalone}/server.js. Chạy next build với output standalone trước.`);
  rm(out);
  cp(standalone, out);
  cp(path.join(root, distDir, "static"), path.join(out, distDir, "static"));
  if (fs.existsSync(path.join(root, "public"))) cp(path.join(root, "public"), path.join(out, "public"));
  cp(path.join(root, "drizzle"), path.join(out, "drizzle"));
  // PGlite loads its .wasm/.data files at runtime; ship the whole package rather than trusting the trace.
  cp(path.join(root, "node_modules", "@electric-sql", "pglite"), path.join(out, "node_modules", "@electric-sql", "pglite"));
  for (const f of fs.readdirSync(out)) if (f.startsWith(".env")) rm(path.join(out, f));
  rm(path.join(out, ".data"));
  rm(path.join(out, "dist"));
  const realStandalone = fs.realpathSync(standalone) + path.sep;
  const tracedModules = path.join(fs.realpathSync(standalone), "node_modules") + path.sep;
  let replaced = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let real = fs.realpathSync(p);
        // Links into the traced node_modules may hold only part of a package: use the full package.
        if (real.startsWith(tracedModules)) real = path.join(root, "node_modules", real.slice(tracedModules.length));
        else if (real.startsWith(realStandalone)) real = path.join(out, real.slice(realStandalone.length));
        fs.unlinkSync(p);
        cp(real, p);
        replaced++;
      } else if (e.isDirectory()) walk(p);
    }
  };
  walk(out);
  const left = [];
  const check = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) left.push(p);
      else if (e.isDirectory()) check(p);
    }
  };
  check(out);
  if (left.length) throw new Error(`Còn symlink: ${left[0]}`);
  return replaced;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [distDir = ".next", out = "standalone-out"] = process.argv.slice(2);
  const n = prepareStandalone(process.cwd(), distDir, path.resolve(out));
  console.log(`✓ ${out} sẵn sàng (thay ${n} symlink).`);
}
