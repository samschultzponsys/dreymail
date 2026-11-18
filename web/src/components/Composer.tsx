// Part of DreyMail, a modified version of Ratatoskr (https://github.com/magnuspihl/Ratatoskr),
// Copyright (C) Magnus Pihl and contributors. Licensed under the GNU AGPL v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-13: puts the signature in and swaps it when the From account changes.
// Modified by samschultzponsys, 2026-11-13: takes on the From account's colour.
// Modified by samschultzponsys, 2026-11-15: send later and undo send.
// Modified by samschultzponsys, 2026-11-17: Schedule button with more quick times; longer send delays.
// Modified by samschultzponsys, 2026-11-17: single line spacing (lines as <div>s, not <p>s).
// Modified by samschultzponsys, 2026-11-17: address bubbles; suggestions per mailbox; Cc/Bcc lines pinned per mailbox, group or all.
// Modified by samschultzponsys, 2026-11-18: importance (high / low) and asking for a read receipt.

import {
  ArrowDown,
  CircleAlert,
  MailCheck,
  Bold,
  Italic,
  Link,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Paperclip,
  Quote,
  RemoveFormatting,
  Send,
  Clock,
  Strikethrough,
  Trash2,
  Underline,
  X,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { resolveAddressLine, setAddressLine, type AddressLine } from '../../../shared/addressLines';
import type { AccountView, AttachmentView, ComposePayload, MessageRef } from '../../../shared/types';
import { accountPalette } from '../accountTheme';
import { AddressField } from './AddressField';
import { api } from '../api';
import { useSignatures } from '../hooks';
import { applySignature, signatureFor } from '../signature';
import { toLocalInput } from '../snooze';
import { formatDelay, formatSize } from '../util';

export interface ComposerInit {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  forwardFrom: MessageRef | null;
  forwardAttachments: AttachmentView[];
  replaceDraft: MessageRef | null;
  answering: MessageRef | null;
  /** Attachments picked before (reopening after "undo send") (DreyMail). */
  files?: File[];
  /** High or low importance (DreyMail). */
  importance?: 'high' | 'low' | null;
  /** Ask for a read receipt (DreyMail). */
  readReceipt?: boolean;
}

function Tool({ title, cmd, arg, children, onRun }: { title: string; cmd?: string; arg?: string; children: ReactNode; onRun?: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault(); // keep the editor selection
        if (onRun) onRun();
        // execCommand is deprecated but remains the only dependency-free rich text primitive.
        else if (cmd) document.execCommand(cmd, false, arg);
      }}
    >
      {children}
    </button>
  );
}

interface Props {
  init: ComposerInit;
  accounts: AccountView[];
  onClose: () => void;
  onToast: (msg: string, error?: boolean, action?: { label: string; run: () => void }, ms?: number) => void;
  onSent: () => void;
  /** Seconds a sent message waits so it can be undone (0 = at once). */
  undoSeconds?: number;
  /** Reopen a composer with this content (after undo send). */
  onReopen?: (init: ComposerInit) => void;
  /** A message was scheduled (the Scheduled list needs refreshing). */
  onScheduled?: () => void;
  /** Mirrors the unsaved-changes state, so browser Back can ask before discarding. */
  dirtyRef?: { current: boolean };
}

export function Composer({ init, accounts, onClose, onToast, onSent, dirtyRef, undoSeconds = 0, onReopen, onScheduled }: Props) {
  const [accountId, setAccountId] = useState(init.accountId);
  const [to, setTo] = useState(init.to);
  const [cc, setCc] = useState(init.cc);
  const [bcc, setBcc] = useState(init.bcc);
  const [importance, setImportance] = useState<'high' | 'low' | null>(init.importance ?? null);
  const [readReceipt, setReadReceipt] = useState(!!init.readReceipt);
  // Cc and Bcc: shown when the settings say so for this mailbox (pinned), or opened for this message.
  const [openLines, setOpenLines] = useState<Record<AddressLine, boolean>>({ cc: !!init.cc, bcc: !!init.bcc });
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups, staleTime: 60_000 });
  const [subject, setSubject] = useState(init.subject);
  const [files, setFiles] = useState<File[]>(init.files ?? []);
  const [fwd, setFwd] = useState<AttachmentView[]>(init.forwardAttachments);
  const [fwdSource, setFwdSource] = useState<MessageRef | null>(init.forwardFrom);
  const [draft, setDraft] = useState<MessageRef | null>(init.replaceDraft);
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The composer takes on the From account's colour, so it's clear which account sends.
  const fromColor = accounts.find((a) => a.id === accountId)?.color;
  const fromPalette = fromColor
    ? { ...accountPalette(fromColor, document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), borderTop: `3px solid ${fromColor}` }
    : undefined;
  /** The signature now in the editor (undefined: none put in yet). */
  const sigShown = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Enter starts a new <div> line, not a <p> (which every mail client shows with a blank line around it).
    document.execCommand('defaultParagraphSeparator', false, 'div');
    if (editor.current) editor.current.innerHTML = init.html;
    sigShown.current = undefined;
    if (init.to) {
      editor.current?.focus();
      // Place the caret at the start (above any quoted text).
      const sel = window.getSelection();
      if (sel && editor.current) {
        sel.collapse(editor.current, 0);
      }
    }
  }, [init.html, init.to]);

  // Signature: put in once the signatures have loaded (not into a draft being edited, which already
  // has whatever the user left in it), and swapped when the From account changes.
  const signatures = useSignatures();
  const isReply = !!(init.answering || init.inReplyTo || init.forwardFrom);
  const sigHtml = init.replaceDraft ? null : (signatureFor(signatures.data, accountId, isReply)?.html ?? null);
  const sigReady = signatures.isSuccess || signatures.isError;
  useEffect(() => {
    if (!editor.current || !sigReady || init.replaceDraft || sigShown.current === sigHtml) return;
    applySignature(editor.current, sigHtml);
    sigShown.current = sigHtml;
  }, [sigHtml, sigReady, init.replaceDraft, init.html]);

  // Unsaved changes: editor input since the last save, or header fields that differ from the last
  // saved (or initial) values.
  const fields = JSON.stringify([to, cc, bcc, subject, accountId, files.length]);
  const [baseline, setBaseline] = useState(fields);
  const unsaved = dirty || fields !== baseline;
  useEffect(() => {
    if (dirtyRef) dirtyRef.current = unsaved;
  }, [unsaved, dirtyRef]);

  const payload = (): ComposePayload => ({
    accountId,
    to,
    cc,
    bcc,
    subject,
    html: editor.current?.innerHTML ?? '',
    inReplyTo: init.inReplyTo,
    references: init.references,
    forwardFrom: fwdSource && fwd.length ? { ...fwdSource, indices: fwd.map((a) => a.index) } : null,
    replaceDraft: draft,
    answering: init.answering,
    importance,
    readReceipt,
  });

  /** The composer as it is now, to reopen it after "undo send". */
  const snapshot = (): ComposerInit => ({
    ...init,
    accountId,
    to,
    cc,
    bcc,
    subject,
    html: editor.current?.innerHTML ?? '',
    forwardFrom: fwdSource,
    forwardAttachments: fwd,
    replaceDraft: draft,
    files,
    importance,
    readReceipt,
  });

  /** Send now (after the undo wait, if any), or at `at` (send later). */
  const send = async (at?: Date) => {
    setBusy('send');
    setError(null);
    try {
      const wait = at ? null : undoSeconds > 0 ? new Date(Date.now() + undoSeconds * 1000) : null;
      const res = await api.send(payload(), files, at ?? wait ?? undefined);
      if (res.scheduled) {
        const id = res.scheduled.id;
        const back = snapshot();
        const undo = { label: 'Undo', run: () => void api.cancelScheduled(id).then(() => (onScheduled?.(), onReopen?.(back)), (e: Error) => onToast(e.message, true)) };
        if (at) onToast(`Scheduled for ${at.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, false, undo);
        else onToast(undoSeconds >= 60 ? `Sending in ${formatDelay(undoSeconds)}…` : 'Sending…', false, undo, undoSeconds * 1000);
        onScheduled?.();
        if (!at) window.setTimeout(onSent, undoSeconds * 1000 + 3000);
      } else {
        onToast(res.warning ? `Sent. ${res.warning}` : 'Message sent', !!res.warning);
        onSent();
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const [laterOpen, setLaterOpen] = useState(false);
  const [laterCustom, setLaterCustom] = useState('');
  const at = (days: number, hour: number, weekday?: number) => {
    const d = new Date();
    if (weekday !== undefined) d.setDate(d.getDate() + ((weekday + 7 - d.getDay()) % 7 || 7));
    else d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  /** Now plus some minutes, rounded up to the next 5 minutes. */
  const inMinutes = (minutes: number) => {
    const d = new Date(Date.now() + minutes * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  };

  const saveDraft = async () => {
    setBusy('draft');
    setError(null);
    try {
      const res = await api.saveDraft(payload(), files);
      let remainingFiles = files.length;
      if (res.draft) {
        setDraft(res.draft);
        // Attachments now live in the saved draft (the previous one was replaced), so future
        // saves and the final send carry them over from there.
        if (files.length || fwd.length) {
          const saved = await api.message(res.draft, 'block');
          setFwdSource(res.draft);
          setFwd(saved.attachments.filter((a) => !a.inline));
          setFiles([]);
          remainingFiles = 0;
        }
      }
      setDirty(false);
      setBaseline(JSON.stringify([to, cc, bcc, subject, accountId, remainingFiles]));
      onToast('Draft saved');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (unsaved && !window.confirm('Discard this message?')) return;
    onClose();
  };

  const addLink = () => {
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) {
      setError('Links must start with https://, http:// or mailto:');
      return;
    }
    document.execCommand('createLink', false, url.trim());
  };

  // Cc/Bcc lines: the most specific setting (this mailbox, its group, all) decides; the pin changes it.
  const fromAccount = accounts.find((a) => a.id === accountId);
  const lineSetting = (l: AddressLine) => resolveAddressLine(me.data?.preferences.addressLines, fromAccount, l);
  const lineShown = (l: AddressLine) => lineSetting(l).show || openLines[l] || !!(l === 'cc' ? cc : bcc).trim();
  const linePin = (l: AddressLine) => {
    const { show, level } = lineSetting(l);
    const groupName = groups.data?.find((g) => g.id === fromAccount?.groupId)?.name;
    return {
      pinned: show,
      scope: level === 'mailbox' ? `${fromAccount?.name ?? 'this mailbox'}` : level === 'group' ? `group ${groupName ?? ''}`.trim() : 'all mailboxes',
      onToggle: () => {
        const prefs = me.data?.preferences;
        if (!prefs) return;
        const next = { ...prefs, addressLines: setAddressLine(prefs.addressLines, fromAccount, level, l, !show) };
        // Unpinned: the line stays for this message, and is a click away next time.
        if (show) setOpenLines((o) => ({ ...o, [l]: true }));
        qc.setQueryData(['me'], { ...me.data, preferences: next });
        void api.savePreferences(next).catch((err: Error) => {
          onToast(err.message, true);
          void qc.invalidateQueries({ queryKey: ['me'] });
        });
      },
    };
  };

  return (
    <div
      className={`composer ${maximized ? 'maximized' : ''}`}
      style={fromPalette as CSSProperties}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void send();
        }
        if (e.key === 'Escape') close();
      }}
    >
      <div className="composer-head">
        <span className="title">{subject || 'New message'}</span>
        <button className="icon-btn" title={maximized ? 'Restore' : 'Maximize'} onClick={() => setMaximized((m) => !m)}>
          {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button className="icon-btn" title="Close" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <div className="field">
        <label>From</label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} <${a.email}>` : a.email} · {a.name}
            </option>
          ))}
        </select>
      </div>
      <AddressField
        label="To"
        value={to}
        onChange={setTo}
        from={accountId}
        extra={(['cc', 'bcc'] as const)
          .filter((l) => !lineShown(l))
          .map((l) => (
            <button key={l} type="button" className="toggle" onClick={() => setOpenLines((o) => ({ ...o, [l]: true }))}>
              {l === 'cc' ? 'Cc' : 'Bcc'}
            </button>
          ))}
      />
      {lineShown('cc') && <AddressField label="Cc" value={cc} onChange={setCc} from={accountId} pin={linePin('cc')} />}
      {lineShown('bcc') && <AddressField label="Bcc" value={bcc} onChange={setBcc} from={accountId} pin={linePin('bcc')} />}
      <div className="field">
        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="toolbar">
        <Tool title="Bold" cmd="bold">
          <Bold size={15} />
        </Tool>
        <Tool title="Italic" cmd="italic">
          <Italic size={15} />
        </Tool>
        <Tool title="Underline" cmd="underline">
          <Underline size={15} />
        </Tool>
        <Tool title="Strikethrough" cmd="strikeThrough">
          <Strikethrough size={15} />
        </Tool>
        <span className="sep" />
        <Tool title="Bulleted list" cmd="insertUnorderedList">
          <List size={15} />
        </Tool>
        <Tool title="Numbered list" cmd="insertOrderedList">
          <ListOrdered size={15} />
        </Tool>
        <Tool title="Quote" cmd="formatBlock" arg="blockquote">
          <Quote size={15} />
        </Tool>
        <Tool title="Link" onRun={addLink}>
          <Link size={15} />
        </Tool>
        <span className="sep" />
        <Tool title="Clear formatting" cmd="removeFormat">
          <RemoveFormatting size={15} />
        </Tool>
      </div>
      <div className="editor">
        {/* Quoted mail is server-sanitized; the container's CSS containment keeps any
            positioned content from escaping the editor area. */}
        <div ref={editor} className="editor-content" contentEditable suppressContentEditableWarning onInput={() => setDirty(true)} />
      </div>
      {(files.length > 0 || fwd.length > 0) && (
        <div className="composer-attachments">
          {fwd.map((a) => (
            <span className="attachment" key={`f${a.index}`}>
              <Paperclip size={13} />
              <span className="fname">{a.filename}</span>
              <span className="fsize">{formatSize(a.size)}</span>
              <button className="remove" title="Remove" onClick={() => setFwd((list) => list.filter((x) => x !== a))}>
                <X size={13} />
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span className="attachment" key={`u${i}`}>
              <Paperclip size={13} />
              <span className="fname">{f.name}</span>
              <span className="fsize">{formatSize(f.size)}</span>
              <button className="remove" title="Remove" onClick={() => setFiles((list) => list.filter((x) => x !== f))}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-foot">
        <button className="btn primary" onClick={() => void send()} disabled={busy !== null}>
          <Send size={15} /> {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
        <span className="send-later">
          <button className="btn" title="Send at a later time" aria-expanded={laterOpen} onClick={() => setLaterOpen((o) => !o)} disabled={busy !== null}>
            <Clock size={15} /> Schedule
          </button>
          {laterOpen && (
            <div className="send-later-menu" role="menu">
              {(
                [
                  ['In 1 hour', inMinutes(60)],
                  ['In 3 hours', inMinutes(180)],
                  ...(new Date().getHours() < 17 ? [['This evening', at(0, 18)] as const] : []),
                  ['Tomorrow morning', at(1, 8)],
                  ['Tomorrow afternoon', at(1, 13)],
                  ['Monday morning', at(0, 8, 1)],
                ] as const
              ).map(([label, when]) => (
                <button key={label} role="menuitem" onClick={() => (setLaterOpen(false), void send(when))}>
                  <span>{label}</span>
                  <span className="muted">{when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                </button>
              ))}
              <form
                className="send-later-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  const when = new Date(laterCustom);
                  if (!Number.isNaN(when.getTime()) && when.getTime() > Date.now()) {
                    setLaterOpen(false);
                    void send(when);
                  }
                }}
              >
                <input className="input" type="datetime-local" value={laterCustom} onChange={(e) => setLaterCustom(e.target.value)} aria-label="Send at" min={toLocalInput(new Date())} />
                <button className="btn" disabled={!laterCustom}>
                  Schedule
                </button>
              </form>
            </div>
          )}
        </span>
        <button className="btn" onClick={() => void saveDraft()} disabled={busy !== null}>
          {busy === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            setFiles((f) => [...f, ...picked]);
            e.target.value = '';
          }}
        />
        <button className="icon-btn" title="Attach files" onClick={() => fileInput.current?.click()}>
          <Paperclip size={17} />
        </button>
        <button className={`icon-btn ${importance === 'high' ? 'on' : ''}`} title="High importance" aria-pressed={importance === 'high'} onClick={() => setImportance((v) => (v === 'high' ? null : 'high'))}>
          <CircleAlert size={17} />
        </button>
        <button className={`icon-btn ${importance === 'low' ? 'on' : ''}`} title="Low importance" aria-pressed={importance === 'low'} onClick={() => setImportance((v) => (v === 'low' ? null : 'low'))}>
          <ArrowDown size={17} />
        </button>
        <button className={`icon-btn ${readReceipt ? 'on' : ''}`} title="Ask for a read receipt" aria-pressed={readReceipt} onClick={() => setReadReceipt((v) => !v)}>
          <MailCheck size={17} />
        </button>
        <span className="grow error-text">{error}</span>
        <button className="icon-btn" title="Discard" onClick={close}>
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
