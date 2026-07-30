/**
 * Migration 010 — OAuth client credentials for the cloud backup providers.
 *
 * Connecting a cloud account needs an OAuth app registered with the provider,
 * and CountRoster is self-hosted, so each deployment registers its own. That
 * registration is a one-time step in the provider's developer console — which
 * a phone can reach perfectly well. Passing the resulting client id to the
 * server is what a phone *can't* do if the only channel is a startup flag, so
 * the credentials live here and can be entered from the Data page instead.
 * The startup flags remain as a fallback for automated deployments.
 *
 * One row per provider rather than columns on `cloud_backup_settings`: both
 * providers can be set up at once, while only one account is ever connected.
 *
 * Like `cloud_backup_settings`, this table is deliberately **not** part of the
 * backup bundle (see backup/tables.ts) — the client secret is a credential,
 * and an export must not carry one.
 */
export const M010_CLOUD_PROVIDER_CREDENTIALS = {
  version: 10,
  name: '010_cloud_provider_credentials',
  up: /* sql */ `
    CREATE TABLE IF NOT EXISTS cloud_provider_credentials (
      provider      TEXT PRIMARY KEY
                    CHECK (provider IN ('dropbox','google_drive')),
      client_id     TEXT NOT NULL,
      client_secret TEXT,
      updated_at    TEXT
    );
  `,
} as const;
