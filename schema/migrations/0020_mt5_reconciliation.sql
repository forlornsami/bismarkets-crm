-- MT5 reconciliation: a nightly (and on-demand) check that MT5 and the CRM
-- agree. A run first syncs every open account's deals into the cache (it
-- only ever reads MT5), then compares the cached deals with the balance
-- operations and the ledger, and records each thing that does not match as
-- an issue. An issue's key says what it is about (an operation, a deal, an
-- account), so a run that finds it again updates the same row instead of
-- adding another, and one that was resolved but is found again reopens.

-- One row per run. Only one run is 'running' at a time across every CRM
-- process (running_flag is unique), and a nightly run's day is unique too:
-- of the processes that try to start it, only the one whose insert succeeds
-- runs it. A run whose heartbeat stops (its process ended mid-run) is taken
-- over by another process (nightly, up to three attempts) or marked failed.
CREATE TABLE mt5_recon_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('nightly', 'manual') NOT NULL,
  -- The UTC day a nightly run is for.
  run_date DATE NULL,
  status ENUM('running', 'done', 'failed') NOT NULL DEFAULT 'running',
  running_flag TINYINT GENERATED ALWAYS AS (IF(status = 'running', 1, NULL)) STORED,
  -- The process running it (a random token), and when it last made progress.
  owner CHAR(32) NOT NULL,
  heartbeat_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 1,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  -- Open accounts on switched-on servers, and how many of them MT5 answered for.
  accounts_total INT UNSIGNED NOT NULL DEFAULT 0,
  accounts_checked INT UNSIGNED NOT NULL DEFAULT 0,
  -- Issues this run found and left open (new or not; not one a person resolved, found just as it was), new or
  -- reopened ones, and critical ones among those found.
  issues_found INT UNSIGNED NOT NULL DEFAULT 0,
  issues_new INT UNSIGNED NOT NULL DEFAULT 0,
  critical_found INT UNSIGNED NOT NULL DEFAULT 0,
  -- Where the next run starts reading balance-type deals newly cached or changed (mt5_deals.created_at, and
  -- changed_at for a deal MT5 changed): a little before where this run read to, or, when it reached its limit,
  -- the last deal it read ({action, server, ticket} in next_deals_after: the next run reads the deals after it).
  next_deals_from DATETIME(3) NULL,
  next_deals_after JSON NULL,
  -- Why it failed, and what it could not cover (a server out of reach, a limit reached). Never MT5 credentials: the CRM has none.
  error VARCHAR(500) NULL,
  notes VARCHAR(1000) NULL,
  started_by BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_mt5_recon_nightly (run_date),
  UNIQUE KEY uq_mt5_recon_running (running_flag),
  KEY ix_mt5_recon_runs_started (started_at),
  CONSTRAINT ck_mt5_recon_run_kind CHECK ((kind = 'nightly' AND run_date IS NOT NULL AND started_by IS NULL)
    OR (kind = 'manual' AND run_date IS NULL AND started_by IS NOT NULL)),
  CONSTRAINT ck_mt5_recon_run_finished CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT fk_mt5_recon_run_staff FOREIGN KEY (started_by) REFERENCES staff_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- What runs found. resolved_by NULL on a resolved issue means a run found it
-- no longer true; otherwise a staff member resolved it with a note. A
-- resolved issue that a run finds again reopens: always for a state the CRM
-- or MT5 should get out of (a ledger problem, a funding gap, an operation
-- still open) or one a run resolved, and for one about a deal, a settled
-- operation or an MT5 account (missing, or with no CRM row) when its facts
-- (fingerprint) differ from when a person resolved it, since those facts do
-- not change by themselves.
CREATE TABLE mt5_recon_issues (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- "<kind>:<what it is about>", such as "op_without_deal:42" or "external_balance_deal:live:9000123".
  issue_key VARCHAR(100) NOT NULL,
  kind ENUM('op_without_deal', 'deal_mismatch', 'failed_op_has_deal', 'unknown_bis_deal', 'ledger_problem', 'funding_mismatch',
    'external_balance_deal', 'unsettled_op', 'account_missing', 'unlinked_mt5_account') NOT NULL,
  severity ENUM('critical', 'warning', 'info') NOT NULL,
  mt5_account_id BIGINT UNSIGNED NULL,
  client_id BIGINT UNSIGNED NULL,
  op_id BIGINT UNSIGNED NULL,
  deal_ticket BIGINT UNSIGNED NULL,
  -- The facts as last found (amounts in cents, logins, references, tickets): for staff only.
  details JSON NOT NULL,
  -- SHA-256 of the details, as found when it was opened or last updated while open.
  fingerprint CHAR(64) NOT NULL,
  status ENUM('open', 'resolved') NOT NULL DEFAULT 'open',
  first_run_id BIGINT UNSIGNED NOT NULL,
  last_run_id BIGINT UNSIGNED NOT NULL,
  -- How many times it came back after being resolved.
  reopened INT UNSIGNED NOT NULL DEFAULT 0,
  resolved_by BIGINT UNSIGNED NULL,
  resolved_at DATETIME(3) NULL,
  resolved_note VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_mt5_recon_issue_key (issue_key),
  KEY ix_mt5_recon_issues_list (status, severity, id),
  KEY ix_mt5_recon_issues_kind (kind, status),
  KEY ix_mt5_recon_issues_client (client_id, status),
  KEY ix_mt5_recon_issues_first_run (first_run_id),
  KEY ix_mt5_recon_issues_last_run (last_run_id),
  CONSTRAINT ck_mt5_recon_issue_resolved CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL AND resolved_note IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_note IS NOT NULL)),
  CONSTRAINT fk_mt5_recon_issue_account FOREIGN KEY (mt5_account_id) REFERENCES mt5_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_recon_issue_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_recon_issue_op FOREIGN KEY (op_id) REFERENCES mt5_balance_ops (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_recon_issue_first_run FOREIGN KEY (first_run_id) REFERENCES mt5_recon_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_recon_issue_last_run FOREIGN KEY (last_run_id) REFERENCES mt5_recon_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_recon_issue_resolved_by FOREIGN KEY (resolved_by) REFERENCES staff_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Balance operations reconciliation is done with: settled, with nothing
-- wrong, and compared with every cached deal that carries their reference or
-- ticket (a completed one once its own deal is cached). Runs look only at the
-- others (new, open, or with an issue), so a run's work follows those rather
-- than the whole history. A deal newly cached, or changed by MT5 since,
-- that carries one of these references or tickets brings its operation back
-- for another look: the run that reads the deal deletes the operation's row
-- here first.
CREATE TABLE mt5_recon_op_checks (
  op_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  -- matched: its one deal, as asked for; no_deal: failed or cancelled, and MT5 has nothing.
  outcome ENUM('matched', 'no_deal') NOT NULL,
  -- Tickets of the cached deals that carried its reference or ticket when it was checked, ascending.
  deal_tickets JSON NOT NULL,
  run_id BIGINT UNSIGNED NULL,
  checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_mt5_recon_check_op FOREIGN KEY (op_id) REFERENCES mt5_balance_ops (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_recon_check_run FOREIGN KEY (run_id) REFERENCES mt5_recon_runs (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Finding an operation's deals by its reference, and the balance-type deals
-- cached or changed since the last run in the order they were stored or
-- rewritten, without reading every trade.
ALTER TABLE mt5_deals
  ADD KEY ix_mt5_deals_comment (comment),
  ADD KEY ix_mt5_deals_stored (created_at, action),
  ADD KEY ix_mt5_deals_changed (changed_at, action);

-- Finding an operation by the ticket MT5 answered for it, so a cached deal
-- whose comment MT5 changed still brings its operation back.
ALTER TABLE mt5_balance_ops
  ADD KEY ix_mt5_ops_ticket (server_code, mt5_ticket);
