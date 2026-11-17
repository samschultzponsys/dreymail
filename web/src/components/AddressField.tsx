// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { Pin, PinOff, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { afterTyping, bubbleLabel, finishDraft, isAddress, joinAddresses, removeAddress, reopenLast, splitAddresses } from '../addresses';
import { api } from '../api';
import { formatAddress } from '../util';

/**
 * A To, Cc or Bcc line: finished addresses as bubbles, then the address being typed, with
 * suggestions from the people you write to and who write to you. The value stays comma-separated
 * text, as drafts, replies and sending use it.
 */
export function AddressField({
  label,
  value,
  onChange,
  from,
  extra,
  pin,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** The mailbox being written from (suggestions can be limited to it, its group, …). */
  from: string;
  extra?: ReactNode;
  /** The line's "always show" pin: whether it is pinned, what pinning applies to, and the toggle. */
  pin?: { pinned: boolean; scope: string; onToggle: () => void };
}) {
  const [suggestions, setSuggestions] = useState<{ name: string; address: string }[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { done, draft } = splitAddresses(value);
  const token = draft.trim();

  // A complete address given to the composer (a reply's sender, a mailto: link) shows as a bubble.
  useEffect(() => {
    if (draft && isAddress(draft) && !focused) onChange(finishDraft(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  useEffect(() => {
    if (!focused || token.length < 1) {
      setSuggestions([]);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .recipients(token, from)
        .then((r) => {
          setSuggestions(r);
          setActive(0);
        })
        .catch(() => setSuggestions([]));
    }, 120);
    return () => window.clearTimeout(t);
  }, [token, focused, from]);

  const pick = (s: { name: string; address: string }) => {
    onChange(joinAddresses([...done, formatAddress(s)]));
    setSuggestions([]);
    input.current?.focus();
  };

  return (
    <div className="field address-field" onClick={() => input.current?.focus()}>
      <label>{label}</label>
      <div className="bubbles">
        {done.map((entry, i) => (
          <span key={`${i}:${entry}`} className={`bubble ${isAddress(entry) ? '' : 'invalid'}`} title={isAddress(entry) ? entry : `${entry} (not a complete address)`}>
            {bubbleLabel(entry)}
            <button
              type="button"
              aria-label={`Remove ${entry}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onChange(removeAddress(value, i));
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={draft}
          onChange={(e) => onChange(afterTyping(joinAddresses(done, e.target.value)))}
          onPaste={(e) => {
            // Several addresses pasted at once: each becomes a bubble.
            const text = e.clipboardData.getData('text');
            if (!/[,;\n]/.test(text)) return;
            e.preventDefault();
            onChange(finishDraft(joinAddresses(done, `${draft}${text.replace(/\r?\n/g, ', ')}`)));
          }}
          onFocus={() => setFocused(true)}
          onBlur={() =>
            window.setTimeout(() => {
              setFocused(false);
              setSuggestions([]);
            }, 150)
          }
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((a) => (e.key === 'ArrowDown' ? Math.min(a + 1, suggestions.length - 1) : Math.max(a - 1, 0)));
            } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length) {
              e.preventDefault();
              pick(suggestions[active]!);
            } else if ((e.key === 'Enter' || e.key === 'Tab') && isAddress(draft)) {
              if (e.key === 'Enter') e.preventDefault();
              onChange(finishDraft(value));
            } else if (e.key === 'Backspace' && !draft && done.length) {
              e.preventDefault();
              onChange(reopenLast(value));
            } else if (e.key === 'Escape' && suggestions.length) {
              e.stopPropagation();
              setSuggestions([]);
            }
          }}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {extra}
      {pin && (
        <button
          type="button"
          className={`icon-btn line-pin ${pin.pinned ? 'on' : ''}`}
          title={pin.pinned ? `Always shown (${pin.scope}): click to show only when needed` : `Always show ${label} (${pin.scope})`}
          aria-pressed={pin.pinned}
          onClick={(e) => {
            e.stopPropagation();
            pin.onToggle();
          }}
        >
          {pin.pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
      )}
      {focused && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s, i) => (
            <button key={s.address} className={i === active ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              {s.name ? (
                <>
                  <strong>{s.name}</strong> <span className="muted">{s.address}</span>
                </>
              ) : (
                s.address
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
