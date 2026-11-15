// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

// The source code offer AGPL-3.0 §13 asks of a network service, with the attribution NOTICE's
// §7(b) term requires: the running version's source, and where DreyMail comes from.

export const REPO_URL = 'https://github.com/samschultzponsys/dreymail';

export function SourceLink({ version }: { version: string | undefined }) {
  const href = version ? `${REPO_URL}/tree/v${version}` : REPO_URL;
  return (
    <div className="source-link">
      DreyMail{version ? ` ${version}` : ''} ·{' '}
      <a href={href} target="_blank" rel="noreferrer">
        Source code
      </a>{' '}
      · based on{' '}
      <a href="https://github.com/magnuspihl/Ratatoskr" target="_blank" rel="noreferrer">
        Ratatoskr
      </a>{' '}
      by Magnus Pihl ·{' '}
      <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
        AGPL-3.0
      </a>
    </div>
  );
}
