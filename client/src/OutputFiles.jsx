import React, { useEffect, useState } from 'react';
import { LuCircleAlert, LuDownload, LuFile, LuFolderOpen, LuLoader } from 'react-icons/lu';
import { api } from './api.js';
import { EmptyState } from './ui.jsx';

const fmtSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// Some flows write artifacts (downloaded PDFs, exported tokens/certs, screenshots, ...) under the
// project's output/ directory as they run. This lists whatever landed there during one run - not
// output/ in general, which is shared across every run - so it only ever shows what THIS run wrote.
export default function OutputFiles({ runId, since }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError('');
    api.output
      .list(since)
      .then((r) => !cancelled && setFiles(r.files))
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [runId, since]);

  if (error) return <div className="notice danger pad"><LuCircleAlert size={14} /><div>{error}</div></div>;
  if (!files) return <div className="list-hint pad"><LuLoader size={13} className="spin" /> Loading output files…</div>;
  if (!files.length) {
    return (
      <EmptyState icon={<LuFolderOpen size={22} />} title="No output files">
        Nothing was written to <span className="mono">output/</span> during this run.
      </EmptyState>
    );
  }
  return (
    <div className="output-files">
      {files.map((f) => (
        <a key={f.relPath} className="output-file-row" href={api.output.fileUrl(f.relPath)} download title={`Download ${f.relPath}`}>
          <LuFile size={14} className="muted" />
          <span className="output-file-name mono">{f.relPath}</span>
          <span className="muted small mono-num">{fmtSize(f.size)}</span>
          <LuDownload size={13} className="muted" />
        </a>
      ))}
    </div>
  );
}
