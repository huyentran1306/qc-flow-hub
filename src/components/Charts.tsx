// Small server-rendered SVG charts. Colours come from CSS variables (--c-pass/--c-block/--c-fail validated
// for colour-vision deficiency in light and dark), every chart has a legend or direct labels, a hover
// tooltip per mark (<title>), and a table view.

type Day = { day: string; passed: number; blocked: number; failed: number };

const SERIES = [
  { key: "passed", label: "Passed", color: "var(--c-pass)" },
  { key: "blocked", label: "Blocked", color: "var(--c-block)" },
  { key: "failed", label: "Failed", color: "var(--c-fail)" },
] as const;

const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return v;
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="chart-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.dashed ? "transparent" : i.color, borderColor: i.color }} className={i.dashed ? "dash" : undefined} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** Results per day, stacked Passed → Blocked → Failed. */
export function DailyResults({ data }: { data: Day[] }) {
  const W = 640;
  const H = 210;
  const pad = { l: 30, r: 8, t: 10, b: 24 };
  const max = niceMax(Math.max(1, ...data.map((d) => d.passed + d.blocked + d.failed)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / data.length;
  const bw = Math.min(22, slot * 0.62);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const empty = data.every((d) => d.passed + d.blocked + d.failed === 0);
  return (
    <figure className="chart">
      <Legend items={SERIES.map((s) => ({ label: s.label, color: s.color }))} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Kết quả test theo ngày trong 14 ngày, tổng ${data.reduce((a, d) => a + d.passed + d.blocked + d.failed, 0)} lượt`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="tick">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.l + i * slot + (slot - bw) / 2;
          let base = 0;
          const total = d.passed + d.blocked + d.failed;
          return (
            <g key={d.day} className="mark">
              <title>{`${dm(d.day)}: ${d.passed} passed, ${d.blocked} blocked, ${d.failed} failed`}</title>
              <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} className="hit" />
              {SERIES.map((s) => {
                const v = d[s.key];
                if (!v) return null;
                const y0 = y(base);
                const y1 = y(base + v);
                base += v;
                const h = Math.max(1, y0 - y1 - (base < total ? 2 : 0));
                return <rect key={s.key} x={x} y={y1} width={bw} height={h} rx={base === total ? 3 : 0} fill={s.color} />;
              })}
              {i % 2 === (data.length - 1) % 2 && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="tick">
                  {dm(d.day)}
                </text>
              )}
            </g>
          );
        })}
        {empty && (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="tick">
            Chưa có lượt chạy nào trong 14 ngày
          </text>
        )}
      </svg>
      <details className="chart-table">
        <summary>Xem bảng số liệu</summary>
        <table>
          <thead>
            <tr>
              <th>Ngày</th>
              <th>Passed</th>
              <th>Blocked</th>
              <th>Failed</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{dm(d.day)}</td>
                <td className="num">{d.passed}</td>
                <td className="num">{d.blocked}</td>
                <td className="num">{d.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Sprint burn-up: test cases passed at least once vs. the sprint's scope. */
export function BurnUp({ scope, days }: { scope: number; days: { day: string; done: number | null }[] }) {
  const W = 640;
  const H = 210;
  const pad = { l: 30, r: 64, t: 12, b: 24 };
  const max = niceMax(Math.max(1, scope));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = Math.max(1, days.length - 1);
  const x = (i: number) => pad.l + (i / n) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const pts = days.map((d, i) => (d.done == null ? null : { x: x(i), y: y(d.done), d })).filter((p): p is NonNullable<typeof p> => !!p);
  const last = pts.at(-1);
  const area = pts.length ? `M${pts[0].x},${y(0)} ` + pts.map((p) => `L${p.x},${p.y}`).join(" ") + ` L${last!.x},${y(0)} Z` : "";
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const every = Math.ceil(days.length / 7);
  return (
    <figure className="chart">
      <Legend
        items={[
          { label: "TC đã Passed", color: "var(--accent)" },
          { label: "Tổng TC cần test", color: "var(--muted)", dashed: true },
        ]}
      />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tiến độ sprint: ${last?.d.done ?? 0} trên ${scope} test case đã Passed`}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="tick">
              {t}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(scope)} y2={y(scope)} className="scope" />
        <text x={W - pad.r + 6} y={y(scope) + 4} className="tick">
          {scope} TC
        </text>
        {area && <path d={area} className="area" />}
        {line && <path d={line} className="line" />}
        {pts.map((p) => (
          <g key={p.d.day} className="mark">
            <title>{`${dm(p.d.day)}: ${p.d.done}/${scope} TC đã Passed`}</title>
            <circle cx={p.x} cy={p.y} r={10} className="hit" />
            <circle cx={p.x} cy={p.y} r={p === last ? 4.5 : 2.5} className="dot" />
          </g>
        ))}
        {last && (
          <text x={last.x + 8} y={last.y - 8} className="label">
            {last.d.done}
          </text>
        )}
        {days.map((d, i) =>
          i % every === 0 || i === days.length - 1 ? (
            <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" className="tick">
              {dm(d.day)}
            </text>
          ) : null,
        )}
      </svg>
      <details className="chart-table">
        <summary>Xem bảng số liệu</summary>
        <table>
          <thead>
            <tr>
              <th>Ngày</th>
              <th>TC đã Passed</th>
              <th>Tổng</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td>{dm(d.day)}</td>
                <td className="num">{d.done ?? "—"}</td>
                <td className="num">{scope}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Horizontal bars, one hue, value labelled at the end of each bar. */
export function HBars({ items, color = "var(--accent)", unit = "" }: { items: { label: string; value: number; href?: string; note?: string }[]; color?: string; unit?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="hbars" role="list">
      {items.map((i) => (
        <div key={i.label} className="hbar" role="listitem" title={`${i.label}: ${i.value}${unit}`}>
          <span className="hbar-label">{i.href ? <a href={i.href}>{i.label}</a> : i.label}</span>
          <span className="hbar-track">
            {i.value > 0 && <span style={{ width: `max(3px, ${(i.value / max) * 100}%)`, background: color }} />}
          </span>
          <span className="hbar-value num">
            {i.value}
            {unit}
            {i.note ? <small> {i.note}</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Bugs per severity, split by status (Open → Resolved → Closed). */
export function BugStacks({ rows }: { rows: { severity: string; open: number; resolved: number; closed: number }[] }) {
  const parts = [
    { key: "open", label: "Đang mở", color: "var(--c-fail)" },
    { key: "resolved", label: "Chờ verify", color: "var(--c-block)" },
    { key: "closed", label: "Đã đóng", color: "var(--c-pass)" },
  ] as const;
  const max = Math.max(1, ...rows.map((r) => r.open + r.resolved + r.closed));
  const label = { critical: "Critical", major: "Major", minor: "Minor" } as Record<string, string>;
  return (
    <figure className="chart">
      <Legend items={parts.map((p) => ({ label: p.label, color: p.color }))} />
      <div className="hbars">
        {rows.map((r) => {
          const total = r.open + r.resolved + r.closed;
          return (
            <div key={r.severity} className="hbar" title={`${label[r.severity]}: ${r.open} đang mở, ${r.resolved} chờ verify, ${r.closed} đã đóng`}>
              <span className="hbar-label">{label[r.severity]}</span>
              <span className="hbar-track stacked" style={{ width: `${(total / max) * 100}%` }}>
                {parts.map((p) => (r[p.key] ? <span key={p.key} style={{ flex: r[p.key], background: p.color }} /> : null))}
              </span>
              <span className="hbar-value num">
                {total}
                {r.open ? <small> · {r.open} mở</small> : null}
              </span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
