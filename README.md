# POP3 → Gmail importer

Small Node.js service that downloads messages from one or more POP3 accounts and imports them into a Gmail account using the Gmail API (`users.messages.import`).

## Key features
- Support for multiple POP3 accounts (configured in `config.yaml`).
- Imports messages preserving original Date header (`internalDateSource: dateHeader`).
- Labels imported messages with a per-account label plus `INBOX` and `UNREAD`.
- Deletes POP3 message only after a successful import.
- OAuth2 web flow for obtaining the Gmail credentials (local callback).
- Built-in rotating logging (winston + winston-daily-rotate-file).
- Persistent per-account import statistics and a small status page (HTML + JSON).

## Quick start
1. Install dependencies:

```pwsh
npm install
```

2. Create Google API credentials and save to `credentials.json` (or update `config.yaml` to point to your file). See the `gmail_functions.js` comments — it expects Google OAuth client JSON with an `installed` or `web` object.

3. Create `config.yaml` (example fields below) and run:

```pwsh
node .\pop3_to_gmail.js .\data\config.yaml
```

## Configuration
- `gmail.client_secrets_file` — path to the Google client credentials JSON (defaults to `credentials.json`).
- `gmail.token_file` — path where OAuth tokens are persisted (defaults to `token.json`).
- `check_interval_minutes` — how often to poll accounts (default: 5).
- `status_port` — optional port for the built-in status page; if not set the app will attempt to use the OAuth redirect port from the credentials so OAuth and status share the same listener.
- `accounts` — array of POP3 account blocks; each account should include `name`, `server`, `port`, `username`, `password`, and optional flags like `tls`, `ssl`, `label`.

Example `config.yaml` (minimal)

```yaml
gmail:
  client_secrets_file: credentials.json
  token_file: token.json

check_interval_minutes: 5

accounts:
  - name: personal-pop3
    server: pop.example.com
    port: 995
    username: user@example.com
    password: secret
    tls: true
    label: "POP3 account"
```

## Status page
`http://localhost:<port>/status` — shows a small table per account with last sync and counts for the last day/week/month/year and total imports.

By default the server binds to the OAuth redirect port (if present in the credentials) so that the OAuth callback and status UI share a single listener. 

Persistent stats are stored under `stats.json` by default. The `stats_store.js` module records per-account import timestamps and last sync status. The store prunes timestamps older than ~400 days to keep the file reasonably small.

## Development notes
Main files:
- `pop3_to_gmail.js` — main loop, account processing.
- `pop3_functions.js` — POP3 helper wrappers using `mailpop3`.
- `gmail_functions.js` — OAuth flow, Gmail helpers.
- `stats_store.js` — persistent stats store used by the status page.

Logs are written to `logs/` and rotated. You can change the log directory with the `LOG_DIR` environment variable or `cfg.log_dir` in `config.yaml`.

