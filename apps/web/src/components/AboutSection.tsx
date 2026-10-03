import { APP_VERSION } from '../version.ts';

/** Where the source lives. AGPL §13: people using a network copy can get it. */
export const SOURCE_URL = 'https://github.com/chinmay28/CountRoster';

/** Generated at build time by scripts/licenses.mjs. */
export const NOTICES_PATH = '/third-party-notices.txt';

/**
 * Licence and attribution. CountRoster is AGPL-3.0, so anyone using it —
 * including over a network — is owed a way to its source; and the permissive
 * licences of what it's built on require their notices to travel with it.
 */
export function AboutSection() {
  return (
    <section className="card data__section" aria-labelledby="about-heading">
      <h2 id="about-heading">About</h2>
      <p className="muted">
        CountRoster {APP_VERSION} is free software under the GNU Affero General Public
        License v3.0.
      </p>
      <div className="data__actions">
        <a className="btn" href={SOURCE_URL} target="_blank" rel="noreferrer">
          Source code
        </a>
        <a className="btn" href={NOTICES_PATH} target="_blank" rel="noreferrer">
          Open-source licences
        </a>
      </div>
    </section>
  );
}
