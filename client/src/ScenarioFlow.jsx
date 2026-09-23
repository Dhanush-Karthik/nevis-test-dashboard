import React, { useEffect, useRef, useState } from 'react';
import { LuCheck, LuChevronRight, LuCog, LuCopy, LuLoader, LuPanelLeftClose, LuPanelLeftOpen, LuPlug, LuRotateCw, LuWorkflow, LuX } from 'react-icons/lu';
import { LuWaypoints } from 'react-icons/lu';
import { useTraceLinks } from './tracing.jsx';
import { EmptyState, IconButton, Sash, Section, StatusDot, usePanelSize, useLocalState, useToast } from './ui.jsx';

const OUTCOME_LABEL = { passed: 'Passed', failed: 'Failed', error: 'Error', null: 'Running' };
const CLOSED = '__closed__'; // details panel closed on purpose: stop auto-following
const STEP_LABEL = { running: 'Running', done: 'Completed', failed: 'Failed' };

function TestListItem({ test, active, onClick }) {
  return (
    <button type="button" className={`flow-test-item ${active ? 'active' : ''}`} onClick={onClick}>
      <StatusDot status={test.outcome || 'running'} />
      <div className="flow-test-item-text">
        <div className="flow-test-name">{test.scenarioName || test.nodeId.slice(0, 60)}</div>
        <div className="flow-test-sub">{test.steps.length} step{test.steps.length === 1 ? '' : 's'}</div>
      </div>
    </button>
  );
}

function StatusIcon({ status }) {
  if (status === 'failed') return <span className="flow-icon flow-icon-failed"><LuX size={13} strokeWidth={3} /></span>;
  if (status === 'running') return <span className="flow-icon flow-icon-running" />;
  return <span className="flow-icon flow-icon-done"><LuCheck size={13} strokeWidth={3} /></span>;
}

function JobCard({ step, selected, onClick }) {
  return (
    <button type="button" className={`flow-card status-${step.status} ${selected ? 'selected' : ''}`} onClick={() => onClick(step)}>
      <StatusIcon status={step.status} />
      <div className="flow-card-body">
        <div className="flow-card-title">{step.name}</div>
        <div className="flow-card-sub">{step.type === 'workflow' ? 'Workflow' : 'Endpoint interaction'}</div>
      </div>
      {step.actions.length > 0 && <span className="flow-card-badge">{step.actions.length}</span>}
    </button>
  );
}

function JobPipeline({ steps, selectedStepId, onSelectStep }) {
  return (
    <div className="flow-diagram">
      {steps.map((step, i) => (
        <React.Fragment key={step.id}>
          <JobCard step={step} selected={selectedStepId === step.id} onClick={onSelectStep} />
          {i < steps.length - 1 && <div className={`flow-connector ${step.status !== 'running' ? 'done' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  );
}

// `auto`: the row should be open on its own (it is the live action, or the one a failed step stopped
// at). A manual toggle wins until `auto` changes, e.g. when the next action starts.
function ActionRow({ action, pytestEntries, auto }) {
  const toast = useToast();
  const [manual, setManual] = useState(null);
  useEffect(() => setManual(null), [auto]);
  const open = manual ?? auto;
  const setOpen = (fn) => setManual(fn(open));
  const rowRef = useRef(null);
  const logRef = useRef(null);
  const stick = useRef(true); // follow the tail unless the user scrolled up
  // An action owns the pytest lines from its "Handling action" line up to the
  // next action/step boundary; endSeq is null while it's still the live one.
  const allLines = pytestEntries.filter((e) => e.seq >= action.startSeq && (action.endSeq === null || e.seq <= action.endSeq));
  const lines = open ? allLines : [];
  // the live action: bring it into view, and keep its newest lines in view as they stream in
  useEffect(() => {
    if (auto) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [auto]);
  useEffect(() => {
    const el = logRef.current;
    if (auto && open && el && stick.current) el.scrollTop = el.scrollHeight;
  }, [auto, open, lines.length]);
  const copy = (e) => {
    e.stopPropagation();
    const text = allLines.map((l) => l.line).join('\n');
    if (!text) { toast('No pytest lines captured for this action', 'info'); return; }
    navigator.clipboard?.writeText(text).then(() => toast(`Copied ${allLines.length.toLocaleString()} line${allLines.length === 1 ? '' : 's'}`)).catch(() => toast('Could not copy to the clipboard', 'error'));
  };
  return (
    <div ref={rowRef} className={`flow-action ${open ? 'open' : ''}`}>
      <div className="flow-action-row">
        <button type="button" className="flow-action-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <LuChevronRight size={14} className="flow-action-chevron" />
          <span className="log-ts">{new Date(action.ts).toLocaleTimeString()}</span>
          <span className="flow-action-name">{action.name}</span>
        </button>
        <IconButton size="xs" icon={<LuCopy size={12} />} title="Copy this action's log lines" onClick={copy} />
      </div>
      {open && (
        <div
          ref={logRef}
          className="flow-action-logs log-surface"
          onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        >
          {lines.map((e) => (
            <div key={e.seq} className="flow-action-log-line">{e.line}</div>
          ))}
          {lines.length === 0 && <div className="list-hint">No pytest lines captured for this action.</div>}
        </div>
      )}
    </div>
  );
}

function StepDetails({ step, pytestEntries, onClose }) {
  const links = useTraceLinks();
  const traceId = links?.byStep?.[step.id];
  const Icon = step.type === 'workflow' ? LuCog : LuPlug;
  return (
    <div className="card flow-details">
      <div className="card-head">
        <Icon size={15} className="muted" />
        <span className="card-title">{step.type === 'workflow' ? 'Workflow' : 'Endpoint interaction'} · <strong>{step.name}</strong></span>
        <span className={`status-chip s-${step.status}`}>{STEP_LABEL[step.status] || step.status}</span>
        <span className="spacer" />
        {traceId && (
          <button type="button" className="btn sm" onClick={() => links.open(traceId, null)} title="Show this step's distributed trace">
            <LuWaypoints size={13} /> View trace
          </button>
        )}
        <IconButton size="sm" icon={<LuX size={15} />} title="Close details" onClick={onClose} />
      </div>

      <Section title="Configuration" defaultOpen={false} flush storageKey="flow.sec.config">
        {step.config ? (
          <table className="kv-table">
            <tbody>
              {Object.entries(step.config)
                .filter(([k]) => k !== 'name')
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="kv-key">{k}</td>
                    <td className="kv-val">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <div className="list-hint">No final config yet — this step may still be running.</div>
        )}
      </Section>

      {step.actions.length > 0 && (
        <Section title="Actions" badge={step.actions.length} flush>
          <div className="flow-actions-list">
            {step.actions.map((a, i) => (
              <ActionRow key={i} action={a} pytestEntries={pytestEntries} auto={step.status !== 'done' && i === step.actions.length - 1} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

export default function ScenarioFlow({ tests, pytestEntries = [], onRerun }) {
  const [selectedTestId, setSelectedTestId] = useState(null); // null = follow the latest scenario
  const [selectedStepId, setSelectedStepId] = useState(null);
  const [listOpen, setListOpen] = useLocalState('flow.listOpen', true);
  const [listW, setListW, resetListW] = usePanelSize('flow.list', 250, 180, 520);

  // Until the user picks a scenario, follow the latest: the running one, else the most recent.
  const autoTest = tests.length ? [...tests].reverse().find((t) => t.outcome === null) || tests[tests.length - 1] : null;
  const selectedTest = tests.find((t) => t.id === selectedTestId) || autoTest;
  // Re-derived from the live `tests` prop every render, so status/config/actions
  // update in place instead of freezing at the moment the node was clicked.
  // Until the user picks a card, follow the live one: the running step, else the last one (the failed
  // step of a failed test), so its actions are visible without an extra click.
  const autoStep = selectedTest ? selectedTest.steps.find((s) => s.status === 'running') || selectedTest.steps[selectedTest.steps.length - 1] || null : null;
  const selectedStep = selectedTest?.steps.find((s) => s.id === selectedStepId) || (selectedStepId === CLOSED ? null : autoStep);

  if (!tests.length) {
    return <EmptyState icon={<LuWorkflow size={26} />} title="No scenario activity yet">Steps appear here as pytest reports them.</EmptyState>;
  }

  return (
    <div className="flow-layout">
      {listOpen && (
        <div className="flow-test-list" style={{ width: listW }}>
          <div className="panel-head slim">
            <span className="panel-title">Scenarios <em className="count">{tests.length}</em></span>
            <IconButton size="sm" icon={<LuPanelLeftClose size={15} />} title="Hide scenario list" onClick={() => setListOpen(false)} />
          </div>
          <div className="panel-scroll tight">
            {tests.map((t) => (
              <TestListItem key={t.id} test={t} active={t.id === selectedTest?.id} onClick={() => { setSelectedTestId(t.id); setSelectedStepId(null); }} />
            ))}
          </div>
          <Sash edge="end" size={listW} onSize={setListW} onReset={resetListW} />
        </div>
      )}

      <div className="flow-main">
        {selectedTest && (
          <>
            <div className="flow-scenario-header">
              {!listOpen && <IconButton size="sm" icon={<LuPanelLeftOpen size={15} />} title="Show scenario list" onClick={() => setListOpen(true)} />}
              <div className="flow-scenario-head-text">
                <div className="flow-scenario-title">{selectedTest.scenarioName || 'Untitled scenario'}{selectedTest._rerun && <em className="flow-rerun-tag">re-run</em>}</div>
                {selectedTest.description && <div className="flow-scenario-desc">{selectedTest.description}</div>}
              </div>
              <span className={`status-chip s-${selectedTest.outcome || 'running'}`}>{OUTCOME_LABEL[selectedTest.outcome] || 'Running'}</span>
              {onRerun && selectedTest.scenarioName && (() => {
                // A scenario is "re-running" for as long as its own most recent re-run hasn't
                // settled - derived straight from the (server-merged) test object itself, not
                // separate state, so this reads right in every view that renders ScenarioFlow
                // (Run tests, History, a popped-out window) without each having to track it.
                const isRerunning = selectedTest._rerun && selectedTest.outcome === null;
                return (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={isRerunning}
                    onClick={() => onRerun(selectedTest.scenarioName)}
                    title="Re-run just this scenario, replacing its result here and in the report"
                  >
                    {isRerunning ? <LuLoader size={13} className="spin" /> : <LuRotateCw size={13} />}
                    {isRerunning ? 'Re-running…' : 'Re-run'}
                  </button>
                );
              })()}
            </div>

            {selectedTest.steps.length === 0 ? (
              <div className="list-hint pad">No workflow or endpoint steps parsed yet.</div>
            ) : (
              <JobPipeline steps={selectedTest.steps} selectedStepId={selectedStep?.id ?? null} onSelectStep={(s) => setSelectedStepId(s.id)} />
            )}

            {selectedStep && <StepDetails key={selectedStep.id} step={selectedStep} pytestEntries={selectedTest._ownLogs || pytestEntries} onClose={() => setSelectedStepId(CLOSED)} />}
          </>
        )}
      </div>
    </div>
  );
}
