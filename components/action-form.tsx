'use client';

import { useActionState, useId, useRef } from 'react';

export type ActionState = { error?: string; success?: string; data?: unknown };
export type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function ActionForm({ action, children, label = 'Save', confirm }: {
  action: Action; children: React.ReactNode; label?: string; confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  return <form ref={form} action={formAction} onSubmit={(event) => {
    if (confirm && !confirmed.current) {
      event.preventDefault();
      dialog.current?.showModal();
    }
    confirmed.current = false;
  }}>
    <div className="form-grid">{children}</div>
    {state.error && <p className="notice error" role="alert">{state.error}</p>}
    {state.success && <p className="notice" role="status">{state.success}</p>}
    {state.data != null && <div className="notice" role="status"><strong>Preview</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{typeof state.data === 'string' ? state.data : JSON.stringify(state.data, null, 2)}</pre></div>}
    <div className="form-actions"><button className="primary" disabled={pending}>{pending ? 'Saving…' : label}</button></div>
    {confirm && <dialog ref={dialog} className="confirm-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <h2 id={titleId}>Please confirm</h2>
      <p id={descriptionId}>{confirm}</p>
      <div className="form-actions">
        <button type="button" className="secondary" autoFocus onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="primary" onClick={() => {
          dialog.current?.close();
          confirmed.current = true;
          form.current?.requestSubmit();
        }}>Confirm</button>
      </div>
    </dialog>}
  </form>;
}

export function Field({ name, label, type = 'text', required = false, defaultValue, options, wide = false }: {
  name: string; label: string; type?: string; required?: boolean; defaultValue?: string;
  options?: { value: string; label: string }[]; wide?: boolean;
}) {
  return <label className={`field ${wide ? 'wide' : ''}`}>{label}{options
    ? <select name={name} defaultValue={defaultValue ?? ''} required={required}><option value="">Select…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
    : type === 'textarea' ? <textarea name={name} defaultValue={defaultValue} required={required}/>
      : <input name={name} type={type} defaultValue={defaultValue} required={required}/>}</label>;
}
