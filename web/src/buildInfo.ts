// dreymail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

import { shortVersion } from '../../shared/versions';

declare const __WEB_VERSION__: string | undefined;

/** The version this web app was built as ("9.0"), or null in tests and the dev server without it. */
export const WEB_VERSION: string | null = typeof __WEB_VERSION__ === 'string' ? shortVersion(__WEB_VERSION__) : null;
