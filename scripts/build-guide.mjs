// Builds docs/HUONG-DAN-SU-DUNG.html: the guide template with screenshots inlined (one file, works offline).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = path.join(root, "docs", "guide");
let html = fs.readFileSync(path.join(dir, "template.html"), "utf8");
html = html.replace(/src="IMG:([\w-]+)"/g, (_, name) => {
  const file = path.join(dir, "img", `${name}.jpg`);
  if (!fs.existsSync(file)) throw new Error(`Thiếu ảnh ${file}`);
  return `src="data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}"`;
});
const out = path.join(root, "docs", "HUONG-DAN-SU-DUNG.html");
fs.writeFileSync(out, html);
console.log(`✓ ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
