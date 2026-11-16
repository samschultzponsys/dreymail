// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { useQueryClient } from '@tanstack/react-query';
import { Bold, FileUp, Italic, Link as LinkIcon, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AccountView, Signature, SignatureInput } from '../../../shared/types';
import { api } from '../api';
import { useAccounts, useSignatures } from '../hooks';
import { importSignature } from '../signatureImport';

/** Most a signature can be, pictures included (the server's limit). */
const MAX_SIGNATURE = 1_500_000;

/**
 * Settings → Signatures. Each signature has a name, rich text and checkboxes for the accounts that
 * use it: tick one account for a per-inbox signature, or several to share one. An account uses at
 * most one signature, so ticking it here moves it from another signature.
 */
export function SignaturesSettings() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const signatures = useSignatures();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['signatures'] });

  if (!accounts.data || !signatures.data) return <div className="hint">Loading…</div>;
  const list = signatures.data;
  const owner = (accountId: string) => list.find((s) => s.accountIds.includes(accountId));

  return (
    <div className="stack">
      <div className="hint">
        A signature is added below the space you type in, above any quoted message. Tick the accounts that use it: one account for a
        per-inbox signature, several to share it.
      </div>
      {list.length === 0 && editing !== 'new' && <div className="empty-note">No signatures yet.</div>}
      {list.map((s) =>
        editing === s.id ? (
          <SignatureEditor
            key={s.id}
            initial={s}
            accounts={accounts.data}
            owner={owner}
            onCancel={() => setEditing(null)}
            onSave={async (input) => {
              await api.updateSignature(s.id, input);
              await refresh();
              setEditing(null);
            }}
            onDelete={async () => {
              await api.deleteSignature(s.id);
              await refresh();
              setEditing(null);
            }}
          />
        ) : (
          <button key={s.id} className="sig-card" onClick={() => setEditing(s.id)} disabled={editing !== null}>
            <span className="sig-card-head">
              <strong>{s.name}</strong>
              <span className="sig-accounts">
                {s.accountIds.length === 0 ? (
                  <span className="muted">Not used by any account</span>
                ) : (
                  accounts.data
                    .filter((a) => s.accountIds.includes(a.id))
                    .map((a) => (
                      <span key={a.id} className="chip">
                        <span className="dot" style={{ background: a.color }} />
                        {a.name}
                      </span>
                    ))
                )}
              </span>
            </span>
            <span className="sig-preview" dangerouslySetInnerHTML={{ __html: s.html || '<em>Empty</em>' }} />
          </button>
        ),
      )}
      {editing === 'new' ? (
        <SignatureEditor
          initial={{ name: list.length ? '' : 'My signature', html: '', accountIds: accounts.data.filter((a) => !owner(a.id)).map((a) => a.id), onReplies: true }}
          accounts={accounts.data}
          owner={owner}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            await api.createSignature(input);
            await refresh();
            setEditing(null);
          }}
        />
      ) : (
        <div>
          <button className="btn" onClick={() => setEditing('new')} disabled={editing !== null}>
            <Plus size={15} /> New signature
          </button>
        </div>
      )}
    </div>
  );
}

function SignatureEditor({
  initial,
  accounts,
  owner,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: SignatureInput & { id?: string };
  accounts: AccountView[];
  owner: (accountId: string) => Signature | undefined;
  onSave: (input: SignatureInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [accountIds, setAccountIds] = useState(initial.accountIds);
  const [onReplies, setOnReplies] = useState(initial.onReplies);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<string | null>(null);

  const importFiles = async (files: File[]) => {
    setError(null);
    setImported(null);
    try {
      const html = await importSignature(files);
      if (html.length > MAX_SIGNATURE) throw new Error('This signature’s pictures are too big (1.5 MB at most). Make them smaller and try again.');
      if (body.current) body.current.innerHTML = html;
      setImported(`Imported ${files.length === 1 ? files[0]!.name : `${files.length} files`}. Check it below, then save.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (body.current) body.current.innerHTML = initial.html;
  }, [initial.html]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const format = (cmd: 'bold' | 'italic' | 'link') => {
    body.current?.focus();
    if (cmd === 'link') {
      const url = window.prompt('Link address', 'https://');
      if (url && /^(https?:|mailto:|tel:)/i.test(url)) document.execCommand('createLink', false, url);
    } else document.execCommand(cmd);
  };

  return (
    <div className="sig-editor">
      <div>
        <label className="label" htmlFor="sig-name">
          Name
        </label>
        <input id="sig-name" className="input" value={name} maxLength={100} placeholder="Work signature" onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label">Signature</label>
        <div className="sig-body">
          <div className="sig-toolbar">
            <button type="button" className="icon-btn" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => format('bold')}>
              <Bold size={15} />
            </button>
            <button type="button" className="icon-btn" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => format('italic')}>
              <Italic size={15} />
            </button>
            <button type="button" className="icon-btn" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={() => format('link')}>
              <LinkIcon size={15} />
            </button>
            <span className="grow" />
            <button type="button" className="btn sig-import" title="Import a signature made for Outlook: its .zip, or its .htm file and pictures" onClick={() => importInput.current?.click()}>
              <FileUp size={15} /> Import from Outlook files
            </button>
            <input
              ref={importInput}
              type="file"
              hidden
              multiple
              accept=".zip,.htm,.html,image/*"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void importFiles(files);
              }}
            />
          </div>
          <div ref={body} className="sig-content" contentEditable suppressContentEditableWarning aria-label="Signature text" />
        </div>
      </div>
      <div>
        <label className="label">Used by</label>
        <div className="check-list">
          {accounts.map((a) => {
            const other = owner(a.id);
            const moves = other && other.id !== initial.id && !initial.accountIds.includes(a.id) && accountIds.includes(a.id);
            return (
              <label key={a.id} className="check">
                <input
                  type="checkbox"
                  checked={accountIds.includes(a.id)}
                  onChange={(e) => setAccountIds(e.target.checked ? [...accountIds, a.id] : accountIds.filter((x) => x !== a.id))}
                />
                <span className="dot" style={{ background: a.color }} />
                {a.name} <span className="muted">{a.email}</span>
                {moves && <span className="muted">(moves from “{other.name}”)</span>}
              </label>
            );
          })}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={onReplies} onChange={(e) => setOnReplies(e.target.checked)} />
        Also add to replies and forwards
      </label>
      {imported && <div className="hint">{imported}</div>}
      {error && <div className="error-text">{error}</div>}
      <div className="row-buttons">
        {onDelete && (
          <button className="btn danger-text" disabled={busy} onClick={() => void run(onDelete)}>
            <Trash2 size={15} /> Delete
          </button>
        )}
        <span className="grow" />
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(async () => {
              const html = body.current?.innerHTML ?? '';
              if (html.length > MAX_SIGNATURE) throw new Error('This signature is too big to save (1.5 MB at most, pictures included). Use smaller pictures.');
              await onSave({ name: name.trim(), html, accountIds, onReplies });
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}
