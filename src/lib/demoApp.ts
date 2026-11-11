// A small "MapDeck" web app with an API and a few deliberate bugs, so the demo project's
// automatic runs have something real to test:
//   - search is case-sensitive (UI and API)            → TC-03 / TC-13 fail
//   - deleting a shared deck shows no warning          → TC-09 fails
//   - DELETE of an unknown id answers 500, not 404     → TC-14 fails

type Deck = { id: string; name: string; owner: string; updatedAt: string; layers: number; sharedWith: number };

const NAMES = ["Hanoi Traffic", "Saigon Flood Zones", "Da Nang Tourism", "Hue Heritage", "Can Tho Rivers", "Hai Phong Port", "Nha Trang Beaches", "Da Lat Farms", "Vung Tau Oil", "Quy Nhon Coast"];

function seed(): Deck[] {
  const out: Deck[] = [];
  for (let i = 0; i < 25; i++) {
    const base = NAMES[i % NAMES.length];
    out.push({
      id: `md-${String(i + 1).padStart(3, "0")}`,
      name: i < NAMES.length ? base : `${base} ${Math.floor(i / NAMES.length) + 1}`,
      owner: ["Ngọc", "Huy", "Minh", "Lan"][i % 4],
      updatedAt: new Date(Date.UTC(2026, 10, 10) - i * 86400000).toISOString().slice(0, 10),
      layers: 2 + ((i * 3) % 9),
      sharedWith: i === 0 ? 3 : 0,
    });
  }
  return out;
}

const g = globalThis as unknown as { __qfhDemoDecks?: Deck[] };
const decks = () => (g.__qfhDemoDecks ??= seed());

export type DemoResponse = { status: number; body: unknown };

/** API under /demo-app/api/… */
export function handleDemoApi(method: string, segments: string[], search: URLSearchParams): DemoResponse {
  const [res, id] = segments;
  if (method === "POST" && res === "reset") {
    g.__qfhDemoDecks = seed();
    return { status: 200, body: { ok: true } };
  }
  if (res !== "mapdecks") return { status: 404, body: { error: "Not found" } };
  if (method === "GET" && !id) {
    const q = search.get("q") ?? "";
    const page = Math.max(1, Number(search.get("page") ?? 1) || 1);
    const all = decks().filter((d) => d.name.includes(q)); // BUG: should be case-insensitive
    return { status: 200, body: { items: all.slice((page - 1) * 20, page * 20), total: all.length, page, pageSize: 20 } };
  }
  if (method === "GET" && id) {
    const d = decks().find((x) => x.id === id);
    return d ? { status: 200, body: d } : { status: 404, body: { error: "Map deck không tồn tại" } };
  }
  if (method === "DELETE" && id) {
    const i = decks().findIndex((x) => x.id === id);
    if (i < 0) return { status: 500, body: { error: "Internal Server Error" } }; // BUG: should be 404
    decks().splice(i, 1);
    return { status: 204, body: null };
  }
  return { status: 405, body: { error: "Method not allowed" } };
}

/** The web page at /demo-app. `?role=view` hides delete actions (correct behaviour). */
export function demoHtml(): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MapDeck · ứng dụng mẫu</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f6f8;color:#111827}
header{background:#1f2937;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
main{max-width:960px;margin:24px auto;padding:0 16px}
.bar{display:flex;gap:8px;margin-bottom:12px}
input{flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}
button{padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;font:inherit;cursor:pointer}
button.danger{color:#b91c1c}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb}
th,td{text-align:left;padding:8px 10px;border-top:1px solid #e5e7eb}
th{background:#f3f4f6;font-size:13px}
.empty{padding:24px;text-align:center;color:#6b7280;background:#fff;border:1px solid #e5e7eb}
.pager{display:flex;gap:6px;margin-top:10px;align-items:center}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center}
.modal.on{display:flex}
.box{background:#fff;padding:20px;border-radius:10px;min-width:320px}
.toast{position:fixed;bottom:20px;right:20px;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;display:none}
</style></head><body>
<header><b>MapDeck</b><span id="who"></span></header>
<main>
<h1>Map deck</h1>
<div class="bar"><input id="q" placeholder="Tìm theo tên Map deck" aria-label="Tìm kiếm"><button id="search">Tìm</button></div>
<div id="list"></div>
<div class="pager" id="pager"></div>
</main>
<div class="modal" id="modal" role="dialog" aria-modal="true"><div class="box"><p id="msg"></p><div class="bar"><button id="cancel">Huỷ</button><button id="ok" class="danger">Xác nhận xoá</button></div></div></div>
<div class="toast" id="toast" role="status"></div>
<script>
const role=new URLSearchParams(location.search).get("role")||"manage";
document.getElementById("who").textContent="Operator · quyền "+(role==="view"?"View":"Manage");
let page=1,pending=null;
const api=(p,o)=>fetch("/demo-app/api"+p,o);
async function load(){
  const q=document.getElementById("q").value;
  const r=await api("/mapdecks?q="+encodeURIComponent(q)+"&page="+page);
  const d=await r.json();
  const el=document.getElementById("list");
  if(!d.items.length){el.innerHTML='<div class="empty">Không tìm thấy Map deck</div>';document.getElementById("pager").innerHTML="";return;}
  el.innerHTML='<table><thead><tr><th>Tên</th><th>Người tạo</th><th>Ngày cập nhật</th><th>Số layer</th>'+(role==="view"?"":"<th></th>")+'</tr></thead><tbody>'+
    d.items.map(x=>'<tr><td>'+x.name+'</td><td>'+x.owner+'</td><td>'+x.updatedAt+'</td><td>'+x.layers+'</td>'+(role==="view"?"":'<td><button class="danger" data-id="'+x.id+'" data-name="'+x.name+'">Xoá</button></td>')+'</tr>').join("")+'</tbody></table>';
  const pages=Math.ceil(d.total/d.pageSize);
  document.getElementById("pager").innerHTML="Trang "+d.page+"/"+pages+" "+Array.from({length:pages},(_,i)=>'<button data-page="'+(i+1)+'">'+(i+1)+'</button>').join("");
}
document.addEventListener("click",async e=>{
  const t=e.target;
  if(t.id==="search"){page=1;load();}
  if(t.dataset.page){page=Number(t.dataset.page);load();}
  if(t.dataset.id){pending=t.dataset.id;document.getElementById("msg").textContent='Xoá Map deck "'+t.dataset.name+'"?';document.getElementById("modal").classList.add("on");} // BUG: no warning for shared decks
  if(t.id==="cancel"){pending=null;document.getElementById("modal").classList.remove("on");}
  if(t.id==="ok"&&pending){await api("/mapdecks/"+pending,{method:"DELETE"});document.getElementById("modal").classList.remove("on");const s=document.getElementById("toast");s.textContent="Đã xoá";s.style.display="block";setTimeout(()=>s.style.display="none",2000);pending=null;load();}
});
document.getElementById("q").addEventListener("keydown",e=>{if(e.key==="Enter"){page=1;load();}});
load();
</script></body></html>`;
}
