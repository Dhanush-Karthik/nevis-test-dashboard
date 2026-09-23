import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuCheck, LuCircleAlert, LuDownload, LuFileText, LuLoader, LuTriangleAlert, LuX } from 'react-icons/lu';
import { api } from './api.js';
import { buildSequence, seqDims, SequenceCanvas } from './tracing.jsx';
import { Checkbox } from './ui.jsx';

// A PDF report for a labelled "Run tests" execution (one or many scenarios), meant to be attached
// to a ticket or a release mail - so it is built and styled as its own light, print-first document,
// not a screenshot of the dark dashboard theme. "Download PDF" hands off to the browser's own
// print-to-PDF: the same engine renders both the preview and the PDF, so nothing about layout,
// fonts or the sequence diagrams can drift between what you see and what gets attached. The
// preview is the actual document, shown as one continuous scroll on screen - no on-screen A4 page
// emulation - and the browser's native print pipeline (@page below) is what paginates it onto real
// paper when it's actually printed or saved as a PDF.
//
// Report generation itself never changes the run: a "manually passed" mark is annotated in the
// document only (see DEFAULT_SECTIONS / overrides below) - History, badges and counts elsewhere
// are untouched.

const DEFAULT_SECTIONS = { cover: true, table: true, detail: true, failures: true, rawLogs: true };
const SECTION_LABELS = {
  cover: 'Cover, summary & run configuration',
  table: 'Per-scenario results table',
  detail: 'Per-scenario step detail & sequence diagrams',
  failures: 'Failure details',
};
// "Main requests" for the report: only calls between named services (no DB / broker / other
// external targets), and nothing trivially fast enough to not be a real business request.
const REPORT_SEQ_OPTS = { internal: false, external: false, minDurationUs: 3000 };
// How wide a diagram is allowed to render before ReportSequence scales it down to fit. Sized for
// the narrowest box it ever sits in: the *printed* page (A4 minus the @page margins in styles.css,
// ~688px) minus the report-scenario and report-step card padding around it (~72px) - not the wider
// on-screen preview, which has more room to spare. Cutting it close here is what let a 3-lane
// diagram (Caller/auth/idm) render wider than its own card and spill past the border in the PDF.
const MAX_DIAGRAM_W = 600;

const isFailed = (t) => t.outcome === 'failed' || t.outcome === 'error';
const stepTraceId = (step) => {
  const id = step?.config?.trace_id;
  return id && /^[0-9a-f]{32}$/i.test(id) ? id.toLowerCase() : null;
};
const fmtSpan = (ms) => {
  if (ms == null || ms < 0) return '–';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtWhen = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export default function ReportFlow({ run, onClose }) {
  const [phase, setPhase] = useState('loading'); // loading | error | config | rendering | preview
  const [error, setError] = useState('');
  const [full, setFull] = useState(null); // full run (config + flow) from the server - scenario re-runs already swapped in there
  const [meta, setMeta] = useState({ title: 'Test Execution Report', description: '' });
  const [sections, setSections] = useState(DEFAULT_SECTIONS);
  const [overrides, setOverrides] = useState({}); // testId -> { manual, reason } ("manually passed" for this report)
  const [traces, setTraces] = useState(null); // traceId -> trace | null

  useEffect(() => {
    let cancelled = false;
    api.run(run.id)
      .then(({ run: r }) => {
        if (cancelled) return;
        setFull(r);
        setPhase('config');
      })
      .catch((e) => !cancelled && (setError(e.message), setPhase('error')));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const failedTests = useMemo(() => (full ? full.flow.filter(isFailed) : []), [full]);

  const generate = async () => {
    setPhase('rendering');
    try {
      if (sections.detail) {
        const ids = new Set();
        for (const t of full.flow) for (const s of t.steps) { const id = stepTraceId(s); if (id) ids.add(id); }
        const entries = await Promise.all([...ids].map(async (id) => [id, await api.tracing.trace(id).catch(() => null)]));
        setTraces(Object.fromEntries(entries));
      }
      setPhase('preview');
    } catch (e) {
      setError(e.message);
      setPhase('config');
    }
  };

  if (phase === 'loading') {
    return createPortal(<div className="overlay"><div className="modal report-modal"><div className="modal-body report-loading"><LuLoader size={18} className="spin" /> Loading the run…</div></div></div>, document.body);
  }
  if (phase === 'error') {
    return createPortal(
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal report-modal">
          <header className="modal-head"><span className="modal-icon"><LuCircleAlert size={16} /></span><h3>Couldn't load this run</h3></header>
          <div className="modal-body report-loading text-danger">{error}</div>
          <footer className="modal-foot"><button type="button" className="btn" onClick={onClose}>Close</button></footer>
        </div>
      </div>,
      document.body
    );
  }
  if (phase === 'config' || phase === 'rendering') {
    return (
      <ReportOptions
        run={full}
        failedTests={failedTests}
        meta={meta}
        setMeta={setMeta}
        sections={sections}
        setSections={setSections}
        overrides={overrides}
        setOverrides={setOverrides}
        busy={phase === 'rendering'}
        error={error}
        onGenerate={generate}
        onClose={onClose}
      />
    );
  }
  return <ReportPreview run={full} meta={meta} sections={sections} overrides={overrides} traces={traces} onClose={onClose} />;
}

function ReportOptions({ run, failedTests, meta, setMeta, sections, setSections, overrides, setOverrides, busy, error, onGenerate, onClose }) {
  const toggle = (key) => setSections((s) => ({ ...s, [key]: !s[key] }));
  const setOverride = (id, patch) => setOverrides((o) => ({ ...o, [id]: { ...o[id], ...patch } }));
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal report-modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <span className="modal-icon"><LuFileText size={16} /></span>
          <h3>Generate report</h3>
        </header>
        <div className="modal-body report-options">
          <div className="notice info small">
            <LuCircleAlert size={14} />
            <div>A print-ready PDF of this run, for a ticket or release mail. Choose what to include, then <b>Generate</b> opens a preview you can download as a PDF.</div>
          </div>
          <div className="field-label"><span>Title</span></div>
          <input className="input" value={meta.title} onChange={(e) => setMeta((m) => ({ ...m, title: e.target.value }))} placeholder="Test Execution Report" />
          <div className="field-label"><span>Description <em>(optional)</em></span></div>
          <textarea
            className="input report-desc-input"
            rows={3}
            value={meta.description}
            onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))}
            placeholder="Context for whoever reads this report - e.g. what release or ticket it covers."
          />
          <div className="field-label"><span>Sections to include</span></div>
          <div className="report-sections">
            {Object.keys(SECTION_LABELS).map((key) => (
              <Checkbox key={key} checked={sections[key]} onChange={() => toggle(key)} label={SECTION_LABELS[key]} />
            ))}
            {sections.failures && (
              <Checkbox className="report-subcheck" checked={sections.rawLogs} onChange={() => setSections((s) => ({ ...s, rawLogs: !s.rawLogs }))} label="Include a raw pytest log excerpt per failed scenario" />
            )}
          </div>
          {failedTests.length > 0 && (
            <>
              <div className="field-label"><span>Failed scenarios</span></div>
              <div className="report-overrides">
                {failedTests.map((t) => {
                  const o = overrides[t.id] || {};
                  return (
                    <div key={t.id} className="report-override-row">
                      <Checkbox checked={!!o.manual} onChange={(v) => setOverride(t.id, { manual: v })} label={t.scenarioName || t.nodeId} />
                      {o.manual && (
                        <input
                          className="input report-reason-input"
                          value={o.reason || ''}
                          onChange={(e) => setOverride(t.id, { reason: e.target.value })}
                          placeholder="Reason shown in the report (e.g. known flaky endpoint, verified manually)"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="field-hint">
                Marking a scenario here shows it as passed in the report only, with the reason noted - the run's real status, History and badges are unchanged.
              </div>
            </>
          )}
          {error && <div className="notice danger small"><LuCircleAlert size={14} /><div>{error}</div></div>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={onGenerate} disabled={busy}>
            {busy ? <LuLoader size={14} className="spin" /> : <LuFileText size={14} />}
            {busy ? 'Preparing…' : 'Generate'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}

// A compact, non-interactive, "main requests only" render of one step's trace, scaled to fit the
// page width - the same SequenceCanvas the Traces tab uses, so it can never look different.
function ReportSequence({ trace }) {
  const seq = useMemo(() => buildSequence(trace.spans, REPORT_SEQ_OPTS), [trace]);
  const stats = useMemo(() => {
    const m = new Map();
    for (const s of trace.spans) {
      const e = m.get(s.service) || { spans: 0, errors: 0, host: null, version: null };
      e.spans += 1;
      if (s.error) e.errors += 1;
      m.set(s.service, e);
    }
    return m;
  }, [trace]);
  if (!seq.calls.length) return <div className="report-note">No main requests to diagram (only database calls, other external calls, or very short calls were found).</div>;
  const dims = seqDims(seq);
  const scale = Math.min(1, MAX_DIAGRAM_W / dims.width);
  return (
    <div className="report-seq" style={{ width: dims.width * scale, height: dims.height * scale }}>
      <div className="report-seq-inner" style={{ width: dims.width, height: dims.height, transform: `scale(${scale})` }}>
        <SequenceCanvas seq={seq} t0={trace.summary.startUs} stats={stats} />
      </div>
    </div>
  );
}

// A scenario's whole sequence at a glance - which workflows/endpoint interactions ran, in order,
// and whether each finished or is where it stopped. Sits above the per-step trace diagrams as an
// overview; reuses Scenario flow's own pipeline look (see ScenarioFlow.jsx's JobPipeline/JobCard)
// so it reads the same in the report as it does live in the dashboard.
function ReportOverview({ steps }) {
  if (!steps.length) return null;
  return (
    <div className="report-overview">
      <div className="report-overview-label">Workflows &amp; endpoint interactions executed</div>
      <div className="flow-diagram report-overview-diagram">
        {steps.map((s, i) => (
          <React.Fragment key={s.id}>
            <div className={`flow-card status-${s.status}`}>
              <span className={`flow-icon ${s.status === 'failed' ? 'flow-icon-failed' : 'flow-icon-done'}`}>
                {s.status === 'failed' ? <LuX size={13} strokeWidth={3} /> : <LuCheck size={13} strokeWidth={3} />}
              </span>
              <div className="flow-card-body">
                <div className="flow-card-title">{s.name}</div>
                <div className="flow-card-sub">{s.type === 'workflow' ? 'Workflow' : 'Endpoint interaction'}</div>
              </div>
            </div>
            {i < steps.length - 1 && <div className={`flow-connector ${s.status !== 'running' ? 'done' : ''}`} />}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function failureFromTrace(trace) {
  if (!trace || !trace.found) return null;
  const seq = buildSequence(trace.spans, { internal: false, external: true });
  const bad = seq.calls.find((c) => c.call.failed || (c.call.status !== null && c.call.status >= 400));
  if (!bad) return null;
  return `${bad.call.method || ''} ${bad.call.path || ''}`.trim() + (bad.call.status !== null ? ` → HTTP ${bad.call.status}` : '') + (bad.call.message ? ` — ${bad.call.message}` : '');
}

// The report's actual content, rendered once and shown as-is - this is both the on-screen preview
// and (via window.print()) the PDF. What you scroll through is exactly what gets attached.
function ReportDocument({ run, meta, sections, overrides, traces }) {
  const c = run.config || {};
  // counts are derived from `run.flow` (not the server's `run.counts`), because a scenario re-run
  // may have flipped an outcome after the server last summarised this run
  const passedRaw = run.flow.filter((t) => t.outcome === 'passed').length;
  const manualCount = run.flow.filter((t) => isFailed(t) && overrides[t.id]?.manual).length;
  const statusOf = (t) => (isFailed(t) && overrides[t.id]?.manual ? 'passed' : t.outcome);
  const failedForReport = run.flow.filter((t) => isFailed(t) && !overrides[t.id]?.manual);

  return (
      <div className="report-root">
        {sections.cover && (
          <section className="report-cover">
            <div className="report-brand">
              <span className="report-kicker">Nevis Test Dashboard</span>
              <span className="report-gen-date">Generated {fmtWhen(Date.now())}</span>
            </div>
            <h1>{meta.title?.trim() || 'Test Execution Report'}</h1>
            <div className="report-cover-sub">{(c.labels || []).join(', ') || run.title || 'Test run'}</div>
            {meta.description?.trim() && <p className="report-cover-desc">{meta.description}</p>}
            <div className="report-kv">
              <div className="report-kv-row"><span className="report-kv-k">Environment</span><span className="report-kv-v">{c.env}{c.namespace ? ` · ${c.namespace}` : ''}</span></div>
              <div className="report-kv-row"><span className="report-kv-k">Exclusion labels</span><span className="report-kv-v">{(c.exclusionLabels || []).join(', ') || '—'}</span></div>
              <div className="report-kv-row"><span className="report-kv-k">Run started</span><span className="report-kv-v">{fmtWhen(run.createdAt)}</span></div>
              <div className="report-kv-row"><span className="report-kv-k">Duration</span><span className="report-kv-v">{fmtSpan((run.endedAt || Date.now()) - run.createdAt)}</span></div>
            </div>
            <div className="report-summary">
              <div className="report-stat"><b>{run.flow.length}</b><span>Scenarios</span></div>
              <div className="report-stat ok"><b>{passedRaw + manualCount}</b><span>Passed</span></div>
              <div className="report-stat bad"><b>{failedForReport.length}</b><span>Failed</span></div>
              {manualCount > 0 && <div className="report-stat warn"><b>{manualCount}</b><span>Manually verified</span></div>}
            </div>
          </section>
        )}

        {sections.table && (
          <section className="report-section">
            <h2>Scenario results</h2>
            <table className="report-table">
              <thead><tr><th>Scenario</th><th>Status</th><th>Duration</th></tr></thead>
              <tbody>
                {run.flow.map((t) => {
                  const manual = isFailed(t) && overrides[t.id]?.manual;
                  const status = statusOf(t);
                  return (
                    <tr key={t.id}>
                      <td>{t.scenarioName || t.nodeId}{t._rerun && <em className="report-rerun-tag">re-run</em>}</td>
                      <td><span className={`status-chip s-${status || 'running'}`}>{status || 'running'}{manual && ' *'}</span></td>
                      <td>{fmtSpan((t.endedAt || Date.now()) - t.startedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {manualCount > 0 && <div className="report-footnote">* Manually verified for this report — see Failure details.</div>}
          </section>
        )}

        {sections.detail && (
          <section className="report-section report-detail-section">
            <h2>Scenario detail</h2>
            {run.flow.map((t) => (
              <div key={t.id} className="report-scenario">
                <div className="report-scenario-head">
                  <h3>{t.scenarioName || t.nodeId}{t._rerun && <em className="report-rerun-tag">re-run</em>}</h3>
                  <span className={`status-chip s-${statusOf(t) || 'running'}`}>{statusOf(t) || 'running'}</span>
                </div>
                {t.description && <p className="report-desc">{t.description}</p>}
                <ReportOverview steps={t.steps} />
                {t.steps.map((s) => {
                  const traceId = stepTraceId(s);
                  const trace = traceId && traces ? traces[traceId] : null;
                  return (
                    <div key={s.id} className="report-step">
                      <div className="report-step-head">
                        <span className={`status-chip s-${s.status === 'done' ? 'passed' : s.status}`}>{s.status}</span>
                        <b>{s.name}</b>
                        <span className="report-step-type">{s.type}</span>
                      </div>
                      {trace && trace.found ? <ReportSequence trace={trace} /> : <div className="report-note">No trace was recorded for this step.</div>}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        )}

        {sections.failures && (
          <section className="report-section report-failures-section">
            <h2>Failure details</h2>
            {failedForReport.length === 0 ? (
              <p className="report-note">No unresolved failures in this run.</p>
            ) : (
              failedForReport.map((t) => {
                const lastStep = t.steps[t.steps.length - 1];
                const traceId = lastStep && stepTraceId(lastStep);
                const trace = traceId && traces ? traces[traceId] : null;
                const detail = failureFromTrace(trace);
                const excerpt = sections.rawLogs ? (t._ownLogs || run.sources?.pytest || []).filter((e) => e.ts >= t.startedAt && e.ts <= (t.endedAt || Date.now())) : [];
                return (
                  <div key={t.id} className="report-failure">
                    <div className="report-scenario-head">
                      <h3><LuTriangleAlert size={14} className="text-danger" /> {t.scenarioName || t.nodeId}</h3>
                    </div>
                    <p className="report-note">{detail || `The scenario ${t.outcome === 'error' ? 'errored' : 'failed'} at step "${lastStep?.name || 'unknown'}". No further detail could be extracted automatically.`}</p>
                    {excerpt.length > 0 && (
                      <pre className="report-log">{excerpt.map((e) => e.line).join('\n')}</pre>
                    )}
                  </div>
                );
              })
            )}
            {manualCount > 0 && (
              <>
                <h3 className="report-manual-title">Manually verified</h3>
                {run.flow.filter((t) => isFailed(t) && overrides[t.id]?.manual).map((t) => (
                  <p key={t.id} className="report-note"><b>{t.scenarioName || t.nodeId}</b>: {overrides[t.id]?.reason || 'Verified manually.'}</p>
                ))}
              </>
            )}
          </section>
        )}

        <div className="report-footer">Nevis Test Dashboard — {meta.title?.trim() || 'Test Execution Report'}</div>
      </div>
  );
}

// What's shown on screen IS the document - no separate on-screen page-box emulation to drift out
// of sync with it. "Download PDF" (window.print()) hands the exact same markup to the browser's
// own print pipeline, which paginates it onto real A4 pages (see the @page rule in styles.css);
// this view just keeps scrolling as one continuous sheet instead of pretending to be pages.
function ReportPreview({ run, meta, sections, overrides, traces, onClose }) {
  // Drives the print-only CSS (see styles.css) via a class instead of relying on @media print
  // alone, so the toolbar can be hidden with the same on/off switch print itself uses.
  useEffect(() => {
    const before = () => document.documentElement.classList.add('printing');
    const after = () => document.documentElement.classList.remove('printing');
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
      document.documentElement.classList.remove('printing');
    };
  }, []);

  return createPortal(
    <div className="report-overlay">
      <div className="report-toolbar no-print">
        <span className="report-toolbar-title"><LuFileText size={15} /> Report preview</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onClose}><LuX size={14} /> Close</button>
        <button type="button" className="btn sm primary" onClick={() => window.print()}><LuDownload size={14} /> Download PDF</button>
      </div>
      <ReportDocument run={run} meta={meta} sections={sections} overrides={overrides} traces={traces} />
    </div>,
    document.body
  );
}
