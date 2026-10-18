-- MT5 trade history: the CRM's copy of every MT5 deal it has read for a
-- client's account, and the closed trades built from them, so the portal
-- and app page through a fixed list instead of asking MT5 on every page
-- (a total that changes between pages makes both of them refuse the list).
-- Deal times are kept twice: as MT5 reported them (the trade server's clock)
-- and turned into UTC by the gateway.

-- One row per MT5 deal. A sync that reads a deal again rewrites the row only
-- when MT5 now reports it differently (a broker cancelling it turns a buy or
-- sell into 13 or 14, BUY_CANCELED or SELL_CANCELED; a dealer can correct
-- it), and builds its position again. Every sync reads the last two days
-- again, so a change made later than that is not seen. Balance, credit and
-- other non-trade deals (action 2 and up) are kept too, for reconciliation;
-- only buys and sells (0 and 1) become trades.
CREATE TABLE mt5_deals (
  server_code VARCHAR(16) NOT NULL,
  ticket BIGINT UNSIGNED NOT NULL,
  mt5_account_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  login BIGINT UNSIGNED NOT NULL,
  -- 0 buy, 1 sell, 2 balance, 3 credit, ... (MT5 deal action).
  action SMALLINT UNSIGNED NOT NULL,
  -- 0 in, 1 out, 2 in/out (a netting reversal), 3 out by (MT5 deal entry).
  entry SMALLINT UNSIGNED NOT NULL,
  position_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  order_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  symbol VARCHAR(64) NOT NULL DEFAULT '',
  -- In 1/10000 of a lot, as MT5 stores it.
  volume BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- The price as MT5 wrote it (a decimal string: never a float).
  price VARCHAR(44) NOT NULL DEFAULT '0',
  profit_cents BIGINT NOT NULL,
  commission_cents BIGINT NOT NULL DEFAULT 0,
  swap_cents BIGINT NOT NULL DEFAULT 0,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  comment VARCHAR(64) NOT NULL DEFAULT '',
  -- Seconds on the trade server's clock, as MT5 reported them.
  time_server BIGINT NOT NULL,
  time_utc DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- When a sync last rewrote the row because MT5 reported the deal differently; null while it is as first
  -- stored. Reconciliation reads a changed deal again from then, so a changed balance deal is checked again.
  changed_at DATETIME(3) NULL,
  -- The deal's own identity, so a deal read again is a duplicate key and nothing else.
  PRIMARY KEY (server_code, ticket),
  KEY ix_mt5_deals_position (mt5_account_id, position_id),
  KEY ix_mt5_deals_time (mt5_account_id, time_utc),
  KEY ix_mt5_deals_client (client_id),
  CONSTRAINT fk_mt5_deal_account FOREIGN KEY (mt5_account_id) REFERENCES mt5_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_deal_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per closed trade: a row of the client's trade history. A trade is
-- a fully closed position or, on a netting account, a closed part of one.
-- Built from the position's deals, and built again whenever a sync reads one
-- of them. Money columns are sums over the row's deals; side, open time and
-- open price come from its opening deals, close time and close price from
-- its last closing deal. A reversal (an INOUT deal) closes what was open and
-- opens the rest the other way under the same position id: the part it
-- closed is a row that ends at that deal, with all of the deal's money, and
-- the part it opened is a row of its own once it is closed, opened at the
-- deal's price and time.
CREATE TABLE mt5_trades (
  mt5_account_id BIGINT UNSIGNED NOT NULL,
  position_id BIGINT UNSIGNED NOT NULL,
  -- Which part of the position: 0 up to its first reversal, then the ticket
  -- of the INOUT deal that opened the part. A key never moves as later deals
  -- come in, so building a position again rewrites the same rows.
  segment BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  server_code VARCHAR(16) NOT NULL,
  login BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) NOT NULL,
  -- 0 buy, 1 sell (the opening deal's action; for a part a reversal opened,
  -- the INOUT deal's).
  side TINYINT UNSIGNED NOT NULL,
  -- The volume opened, in 1/10000 of a lot (for a part a reversal opened,
  -- what that deal opened plus any added after it).
  volume BIGINT UNSIGNED NOT NULL,
  open_price VARCHAR(44) NOT NULL,
  close_price VARCHAR(44) NOT NULL,
  open_time_utc DATETIME(3) NOT NULL,
  close_time_utc DATETIME(3) NOT NULL,
  profit_cents BIGINT NOT NULL,
  commission_cents BIGINT NOT NULL,
  swap_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (mt5_account_id, position_id, segment),
  KEY ix_mt5_trades_client (client_id, close_time_utc, position_id),
  KEY ix_mt5_trades_account (mt5_account_id, close_time_utc, position_id),
  CONSTRAINT ck_mt5_trade_side CHECK (side IN (0, 1)),
  CONSTRAINT fk_mt5_trade_account FOREIGN KEY (mt5_account_id) REFERENCES mt5_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_trade_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- How far each account's deals are in the cache.
-- deals_synced_until: the UTC time the cache is complete to.
-- deals_synced_at: when the last sync ended, whether or not it worked
--   (deals_sync_error says what went wrong, for staff).
-- deals_sync_partial: the last sync stopped before it reached the present
--   (its time ran out, or MT5 stopped answering after some pages): the next
--   one carries on from deals_synced_until instead of looking two days back,
--   so a big account's first sync gets through in several goes.
ALTER TABLE mt5_accounts
  ADD COLUMN deals_synced_until DATETIME(3) NULL,
  ADD COLUMN deals_synced_at DATETIME(3) NULL,
  ADD COLUMN deals_sync_error VARCHAR(200) NULL,
  ADD COLUMN deals_sync_partial TINYINT(1) NOT NULL DEFAULT 0,
  ADD KEY ix_mt5_accounts_deals (status, deals_synced_at);
