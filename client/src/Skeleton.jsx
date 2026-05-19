// Shared skeleton primitives used while pollers do their first fetch.
// All purely presentational — the shimmer keyframe is defined in styles.css
// (`.skeleton`, `.skel-row`).

// `SkeletonRows` — drop into a <tbody> while data is null. Renders `count`
// rows, each with `cols` cells styled as shimmer bars. Column widths
// cascade from the .skel-row td:nth-child(N) rules in styles.css.
export function SkeletonRows({ rows = 6, cols = 5 }) {
  const idx = Array.from({ length: rows });
  return (
    <>
      {idx.map((_, i) => (
        <tr key={`skel-${i}`} className="skel-row" aria-hidden="true">
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j}><span /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

// `SkeletonCards` — grid of card-shaped placeholders. Used while
// Services / Projects-style pages do their first load.
export function SkeletonCards({ count = 6 }) {
  return (
    <div className="grid cols-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="card" key={i}>
          <div className="skeleton skel-line" style={{ width: '55%' }} />
          <div className="skeleton skel-line" style={{ width: '30%', marginTop: 10 }} />
          <div className="skeleton skel-block" style={{ marginTop: 12 }} />
        </div>
      ))}
    </div>
  );
}
