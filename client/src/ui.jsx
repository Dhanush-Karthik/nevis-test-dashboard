import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LuCalendar,
  LuCheck,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuCircleCheck,
  LuCircleX,
  LuInfo,
  LuSearch,
  LuX,
} from 'react-icons/lu';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(`nevis.${key}`);
      return raw === null ? initial : JSON.parse(raw);
    } catch (_) {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`nevis.${key}`, JSON.stringify(value));
    } catch (_) {
      /* storage unavailable - preference just isn't remembered */
    }
  }, [key, value]);
  return [value, setValue];
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ------------------------------------------------------------------ */
/* Popover: anchored, portalled, closes on outside click / Escape       */
/* ------------------------------------------------------------------ */

export function Popover({ anchorRef, open, onClose, width, minWidth, align = 'start', maxHeight = 320, children, className = '' }) {
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);

  const place = useCallback(() => {
    const a = anchorRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const popH = popRef.current?.offsetHeight || 0;
    const popW = popRef.current?.offsetWidth || 0;
    const spaceBelow = window.innerHeight - r.bottom;
    const flip = popH > spaceBelow - 12 && r.top > spaceBelow;
    const top = flip ? Math.max(8, r.top - popH - 4) : r.bottom + 4;
    let left = align === 'end' ? r.right - (width || popW || r.width) : r.left;
    left = clamp(left, 8, Math.max(8, window.innerWidth - (width || popW || r.width) - 8));
    setPos({ top, left, width: width || r.width, maxH: flip ? r.top - 16 : spaceBelow - 16 });
  }, [anchorRef, align, width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, children]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => {
      if (popRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const reflow = (e) => {
      if (popRef.current?.contains(e.target)) return;
      place();
    };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [open, onClose, place, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={popRef}
      className={`popover ${className}`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: width || undefined,
        minWidth: minWidth || pos?.width,
        maxHeight: Math.min(maxHeight, pos?.maxH || maxHeight),
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Select (replaces the native <select>)                                */
/* ------------------------------------------------------------------ */

const norm = (o) => (typeof o === 'string' ? { value: o, label: o } : o);

export function Select({ value, onChange, options, placeholder = 'Select…', searchable, disabled, size = 'md', className = '', menuWidth, title, icon }) {
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const items = useMemo(() => options.map(norm), [options]);
  const selected = items.find((o) => o.value === value);
  const showSearch = searchable ?? items.length > 9;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((o) => !o.heading && String(o.label).toLowerCase().includes(needle)) : items;
  }, [items, q]);
  // arrow keys hop over group headings / disabled rows
  const stepHi = (from, dir) => {
    let i = from + dir;
    while (i >= 0 && i < visible.length && (visible[i].heading || visible[i].disabled)) i += dir;
    return i >= 0 && i < visible.length ? i : from;
  };

  useEffect(() => {
    if (open) {
      setQ('');
      const at = items.findIndex((o) => o.value === value);
      setHi(at >= 0 ? at : items.findIndex((o) => !o.heading && !o.disabled));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[data-hi="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [hi, open, visible.length]);

  const choose = (o) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKey = (e) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => stepHi(h, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => stepHi(h, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible[hi]) choose(visible[hi]);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        disabled={disabled}
        className={`select select-${size} ${open ? 'open' : ''} ${className}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon && <span className="select-icon">{icon}</span>}
        <span className={`select-value ${selected ? '' : 'placeholder'}`}>{selected ? selected.label : placeholder}</span>
        <LuChevronDown className="select-caret" size={14} />
      </button>
      <Popover anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={menuWidth} className="menu-pop">
        {showSearch && (
          <div className="menu-search">
            <LuSearch size={13} />
            <input
              autoFocus
              value={q}
              placeholder="Search…"
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={onKey}
            />
          </div>
        )}
        <div className="menu-list" role="listbox" ref={listRef} tabIndex={-1}>
          {visible.map((o, i) => o.heading ? (
            <div key={`h-${o.label}`} className="menu-heading">{o.label}</div>
          ) : (
            <div
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              data-hi={i === hi}
              className={`menu-item ${o.value === value ? 'selected' : ''} ${i === hi ? 'hi' : ''} ${o.disabled ? 'disabled' : ''}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => choose(o)}
            >
              <span className="menu-item-label">{o.label}</span>
              {o.hint && <span className="menu-item-hint">{o.hint}</span>}
              {o.value === value && <LuCheck size={14} className="menu-item-check" />}
            </div>
          ))}
          {!visible.length && <div className="menu-empty">No matches</div>}
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Menu button (actions list)                                           */
/* ------------------------------------------------------------------ */

export function MenuButton({ label, icon, items, title, align = 'end', className = 'btn', caret = true, disabled }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" title={title} disabled={disabled} className={`${className} ${open ? 'open' : ''}`} onClick={() => setOpen((o) => !o)}>
        {icon}
        {label && <span>{label}</span>}
        {caret && <LuChevronDown size={13} className="btn-caret" />}
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} align={align} minWidth={190} className="menu-pop">
        <div className="menu-list">
          {items.map((it) =>
            it.separator ? (
              <div key={it.key} className="menu-sep" />
            ) : it.heading ? (
              <div key={it.key} className="menu-heading">{it.heading}</div>
            ) : (
              <div
                key={it.key}
                className={`menu-item ${it.disabled ? 'disabled' : ''}`}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.icon && <span className="menu-item-icon">{it.icon}</span>}
                <span className="menu-item-label">{it.label}</span>
                {it.hint && <span className="menu-item-hint">{it.hint}</span>}
              </div>
            )
          )}
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Combobox: free text input with suggestions (replaces <datalist>)     */
/* ------------------------------------------------------------------ */

export function Combobox({ value, onChange, suggestions = [], placeholder, onCommit, className = '', bare, autoFocus, multiToken, onKeyDownExtra, onBlurExtra }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const token = multiToken ? value.split(/[\s,]+/).pop() : value;
  const list = useMemo(() => {
    const needle = token.trim().toLowerCase();
    const src = suggestions.filter((s) => !needle || (s.toLowerCase().includes(needle) && s.toLowerCase() !== needle));
    return src.slice(0, 60);
  }, [suggestions, token]);

  const apply = (s) => {
    if (multiToken) {
      const head = value.slice(0, value.length - token.length);
      onChange(`${head}${s} `);
    } else {
      onChange(s);
    }
    onCommit?.(s);
    setOpen(false);
    setHi(-1);
  };

  return (
    <>
      <input
        ref={ref}
        autoFocus={autoFocus}
        className={`input ${bare ? 'input-bare' : ''} ${className}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (open && list.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(list.length - 1, h + 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && hi >= 0) {
              e.preventDefault();
              apply(list[hi]);
              return;
            }
          }
          if (e.key === 'Escape') setOpen(false);
          onKeyDownExtra?.(e);
        }}
        onBlur={() => onBlurExtra?.()}
        spellCheck={false}
      />
      <Popover anchorRef={ref} open={open && list.length > 0} onClose={() => setOpen(false)} className="menu-pop" minWidth={200}>
        <div className="menu-list">
          {list.map((s, i) => (
            <div key={s} className={`menu-item ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); apply(s); }}>
              <span className="menu-item-label">{s}</span>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Date-time picker (replaces <input type="datetime-local">)            */
/* ------------------------------------------------------------------ */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');

export function toLocalValue(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function parseLocal(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDisplay(v) {
  const d = parseLocal(v);
  if (!d) return '';
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function TimeUnit({ value, max, onChange, label }) {
  const [text, setText] = useState(pad2(value));
  useEffect(() => setText(pad2(value)), [value]);
  const commit = (raw) => {
    const n = clamp(parseInt(raw, 10) || 0, 0, max);
    setText(pad2(n));
    onChange(n);
  };
  return (
    <input
      className="time-unit"
      aria-label={label}
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 2))}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value);
        if (e.key === 'ArrowUp') { e.preventDefault(); commit(String((value + 1) % (max + 1))); }
        if (e.key === 'ArrowDown') { e.preventDefault(); commit(String((value + max) % (max + 1))); }
      }}
    />
  );
}

export function DateTimeField({ value, onChange, placeholder = 'Select date & time', title, size = 'md', className = '', block }) {
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const current = parseLocal(value);
  const [view, setView] = useState(() => current || new Date());
  const [draft, setDraft] = useState(() => current || new Date());

  useEffect(() => {
    if (open) {
      const base = parseLocal(value) || new Date();
      setView(new Date(base.getFullYear(), base.getMonth(), 1));
      setDraft(base);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const y = view.getFullYear();
  const m = view.getMonth();
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7; // week starts Monday
  const cells = Array.from({ length: 42 }, (_, i) => new Date(y, m, 1 - lead + i));
  const today = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const setDay = (d) => setDraft(new Date(d.getFullYear(), d.getMonth(), d.getDate(), draft.getHours(), draft.getMinutes(), draft.getSeconds()));
  const setTime = (k, n) => {
    const d = new Date(draft);
    if (k === 'h') d.setHours(n);
    if (k === 'm') d.setMinutes(n);
    if (k === 's') d.setSeconds(n);
    setDraft(d);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={title}
        className={`select select-${size} datefield ${open ? 'open' : ''} ${block ? 'block' : ''} ${className}`}
        onClick={() => setOpen((o) => !o)}
      >
        <LuCalendar size={14} className="select-icon" />
        <span className={`select-value ${value ? '' : 'placeholder'}`}>{value ? fmtDisplay(value) : placeholder}</span>
        {value && (
          <span
            className="select-clear"
            role="button"
            aria-label="Clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
          >
            <LuX size={13} />
          </span>
        )}
      </button>
      <Popover anchorRef={btnRef} open={open} onClose={() => setOpen(false)} width={272} maxHeight={460} className="cal-pop">
        <div className="cal-head">
          <button type="button" className="icon-btn sm" onClick={() => setView(new Date(y, m - 1, 1))} aria-label="Previous month">
            <LuChevronLeft size={15} />
          </button>
          <span className="cal-title">{MONTHS[m]} {y}</span>
          <button type="button" className="icon-btn sm" onClick={() => setView(new Date(y, m + 1, 1))} aria-label="Next month">
            <LuChevronRight size={15} />
          </button>
        </div>
        <div className="cal-grid cal-dow">
          {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => <span key={d}>{d}</span>)}
        </div>
        <div className="cal-grid">
          {cells.map((d) => (
            <button
              type="button"
              key={d.toISOString()}
              className={`cal-day ${d.getMonth() !== m ? 'out' : ''} ${same(d, today) ? 'today' : ''} ${same(d, draft) ? 'sel' : ''}`}
              onClick={() => setDay(d)}
            >
              {d.getDate()}
            </button>
          ))}
        </div>
        <div className="cal-time">
          <span className="cal-time-label">Time</span>
          <TimeUnit label="Hours" value={draft.getHours()} max={23} onChange={(n) => setTime('h', n)} />
          <span>:</span>
          <TimeUnit label="Minutes" value={draft.getMinutes()} max={59} onChange={(n) => setTime('m', n)} />
          <span>:</span>
          <TimeUnit label="Seconds" value={draft.getSeconds()} max={59} onChange={(n) => setTime('s', n)} />
        </div>
        <div className="cal-foot">
          <button type="button" className="btn sm ghost" onClick={() => { setDraft(new Date()); setView(new Date()); }}>Now</button>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
          <button type="button" className="btn sm primary" onClick={() => { onChange(toLocalValue(draft.getTime())); setOpen(false); }}>Apply</button>
        </div>
      </Popover>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Small controls                                                       */
/* ------------------------------------------------------------------ */

export function Checkbox({ checked, onChange, label, disabled, className = '', title }) {
  return (
    <label className={`checkbox ${disabled ? 'disabled' : ''} ${className}`} title={title}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden="true">
        <LuCheck size={12} strokeWidth={3} />
      </span>
      {label !== undefined && <span className="checkbox-label">{label}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label, title }) {
  return (
    <label className="switch" title={title}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track"><span className="switch-thumb" /></span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  );
}

export function Segmented({ value, onChange, options, size = 'md', block = true }) {
  return (
    <div className={`seg seg-${size} ${block ? 'block' : ''}`} role="tablist">
      {options.map((o) => {
        const opt = norm(o);
        return (
          <button key={opt.value} type="button" role="tab" aria-selected={value === opt.value} className={value === opt.value ? 'active' : ''} onClick={() => onChange(opt.value)}>
            {opt.icon}
            <span>{opt.label}</span>
            {opt.count !== undefined && <em>{opt.count}</em>}
          </button>
        );
      })}
    </div>
  );
}

export function IconButton({ icon, title, onClick, active, disabled, size = 'md', className = '' }) {
  return (
    <button type="button" className={`icon-btn ${size} ${active ? 'active' : ''} ${className}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      {icon}
    </button>
  );
}

export function Field({ label, hint, children, className = '', right }) {
  return (
    <div className={`field ${className}`}>
      {label !== undefined && (
        <div className="field-label">
          <span>{label}</span>
          {right}
        </div>
      )}
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

/* Collapsible section (used for cards, panels, groups) */
export function Section({ title, icon, children, defaultOpen = true, actions, badge, flush, storageKey, className = '' }) {
  const [stored, setStored] = useLocalState(storageKey || '_unused', defaultOpen);
  const [local, setLocal] = useState(defaultOpen);
  const open = storageKey ? stored : local;
  const setOpen = storageKey ? setStored : setLocal;
  return (
    <section className={`section ${open ? 'open' : 'closed'} ${flush ? 'flush' : ''} ${className}`}>
      <header className="section-head" onClick={() => setOpen(!open)}>
        <LuChevronRight size={14} className="section-chevron" />
        {icon && <span className="section-icon">{icon}</span>}
        <span className="section-title">{title}</span>
        {badge !== undefined && badge !== null && <span className="section-badge">{badge}</span>}
        {actions && <span className="section-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function EmptyState({ icon, title, children }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-sub">{children}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 720, footer, icon }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: `min(${width}px, 94vw)` }} role="dialog" aria-modal="true">
        <header className="modal-head">
          {icon && <span className="modal-icon">{icon}</span>}
          <h3>{title}</h3>
          <IconButton icon={<LuX size={16} />} title="Close" onClick={onClose} size="sm" />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                               */
/* ------------------------------------------------------------------ */

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.tone}`}>
              {t.tone === 'ok' ? <LuCircleCheck size={15} /> : t.tone === 'error' ? <LuCircleX size={15} /> : <LuInfo size={15} />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* VS Code-style resizing                                               */
/* ------------------------------------------------------------------ */

// Persisted panel size + a sash. `edge` says which side of the panel the sash sits
// on: dragging toward the panel shrinks it, away grows it.
export function usePanelSize(key, initial, min, max) {
  const [size, setSize] = useLocalState(`size.${key}`, initial);
  const set = useCallback((n) => setSize(clamp(Math.round(n), min, typeof max === 'function' ? max() : max)), [setSize, min, max]);
  return [clamp(size, min, typeof max === 'function' ? Math.max(min, max()) : max), set, () => setSize(initial)];
}

export function Sash({ orientation = 'vertical', edge = 'end', size, onSize, onReset, className = '' }) {
  const [drag, setDrag] = useState(false);
  const start = (e) => {
    e.preventDefault();
    const origin = orientation === 'vertical' ? e.clientX : e.clientY;
    const base = size;
    // dragging toward the panel (against `edge`) grows/shrinks accordingly
    const sign = edge === 'end' ? 1 : -1;
    setDrag(true);
    document.body.classList.add(orientation === 'vertical' ? 'resizing-col' : 'resizing-row');
    const move = (ev) => {
      const cur = orientation === 'vertical' ? ev.clientX : ev.clientY;
      onSize(base + sign * (cur - origin));
    };
    const up = () => {
      setDrag(false);
      document.body.classList.remove('resizing-col', 'resizing-row');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={`sash sash-${orientation} sash-${edge} ${drag ? 'active' : ''} ${className}`}
      onPointerDown={start}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
    />
  );
}

export function StatusDot({ status }) {
  return <span className={`sdot s-${status || 'stopped'}`} />;
}

/* ------------------------------------------------------------------ */
/* Unified diff viewer                                                  */
/* ------------------------------------------------------------------ */

export function parseDiff(text) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      rows.push({ type: 'hunk', text: line });
    } else if (line.startsWith('diff --git')) {
      inHunk = false;
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith('+')) {
      rows.push({ type: 'add', n: newNo, text: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith('-')) {
      rows.push({ type: 'del', o: oldNo, text: line.slice(1) });
      oldNo += 1;
    } else if (line.startsWith('\\')) {
      rows.push({ type: 'meta', text: line });
    } else if (line !== '' || rows.length) {
      rows.push({ type: 'ctx', o: oldNo, n: newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
  }
  while (rows.length && rows[rows.length - 1].type === 'ctx' && rows[rows.length - 1].text === '') rows.pop();
  return rows;
}

export function DiffView({ diff, empty = 'No changes' }) {
  const rows = useMemo(() => parseDiff(diff), [diff]);
  if (!rows.length) return <div className="diff-empty">{empty}</div>;
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  return (
    <div className="diff">
      <div className="diff-stat">
        <span className="text-ok">+{added}</span>
        <span className="text-danger">−{removed}</span>
      </div>
      <div className="diff-body">
        {rows.map((r, i) =>
          r.type === 'hunk' ? (
            <div key={i} className="drow hunk"><span className="dnum" /><span className="dnum" /><span className="dsign" /><span className="dtext">{r.text}</span></div>
          ) : (
            <div key={i} className={`drow ${r.type}`}>
              <span className="dnum">{r.o ?? ''}</span>
              <span className="dnum">{r.n ?? ''}</span>
              <span className="dsign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}</span>
              <span className="dtext">{r.text}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
