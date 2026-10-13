import type { ExportModel } from '@/lib/jsa/exportModel';

/** Print-ready HTML rendering of a JSA (used for print preview and Save-as-PDF from the browser). */
export function JsaPaper({ m }: { m: ExportModel }) {
  const small = m.meta.filter((x) => !x.wide);
  const pairs: (typeof small)[] = [];
  for (let i = 0; i < small.length; i += 2) pairs.push(small.slice(i, i + 2));
  return (
    <div className={`jsa-paper ${m.orientation}${m.draft ? ' is-draft' : ''}`}>
      {m.draft && <div className="jsa-wm" aria-hidden>DRAFT</div>}
      <div className="jsa-paper-head">
        <div>{m.logo ? <img src={m.logo} alt={m.company} className="jsa-logo" /> : <strong>{m.company}</strong>}</div>
        <div style={{ textAlign: 'right' }}>
          <div className="jsa-co">{m.company}</div>
          <div className={`jsa-title${m.draft ? ' draft' : ''}`}>{m.title}{m.draft ? ' — DRAFT' : ''}</div>
          {m.address && <div className="jsa-addr">{m.address}</div>}
        </div>
      </div>

      <table className="jsa-meta"><tbody>
        {pairs.map((p, i) => (
          <tr key={i}><th>{p[0].label}</th><td>{p[0].value}</td><th>{p[1]?.label}</th><td>{p[1]?.value}</td></tr>
        ))}
        {m.meta.filter((x) => x.wide).map((x) => <tr key={x.label}><th>{x.label}</th><td colSpan={3} style={{ whiteSpace: 'pre-wrap' }}>{x.value}</td></tr>)}
      </tbody></table>

      <table className="jsa-main">
        <thead><tr><th style={{ width: '5%' }}>No.</th><th style={{ width: '20%' }}>Work Activity</th><th style={{ width: '18%' }}>Risk / Hazard</th><th>Control Measures</th></tr></thead>
        <tbody>
          {m.activities.flatMap((a) => a.hazards.map((h, hi) => (
            <tr key={`${a.no}-${hi}`}>
              {hi === 0 && <td rowSpan={a.hazards.length} className="c strong">{a.no}</td>}
              {hi === 0 && <td rowSpan={a.hazards.length} className="strong">{a.title}{a.equipment && <div className="jsa-eq">Equipment: {a.equipment}</div>}</td>}
              <td className="strong">{h.name}</td>
              <td>{h.controls.length ? <ol className="jsa-ol">{h.controls.map((c, i) => <li key={i}><span className="jsa-oln">{i + 1}.</span><span>{c}</span></li>)}</ol> : <em className="jsa-none">No control measures entered.</em>}</td>
            </tr>
          )))}
        </tbody>
      </table>

      {m.signatures.length > 0 && (
        <table className="jsa-sign"><thead><tr>{m.signatures.map((s) => <th key={s}>{s}</th>)}</tr></thead>
          <tbody><tr>{m.signatures.map((s) => <td key={s}><div>Name:</div><div>Signature:</div><div>Date:</div></td>)}</tr></tbody></table>
      )}
      <div className="jsa-foot-note">{m.notice}</div>
      <div className="jsa-foot">{m.company} · {m.number} · Rev {m.revision}{m.draft ? ' · DRAFT' : ''}{m.footer ? ` · ${m.footer}` : ''}</div>
    </div>
  );
}
