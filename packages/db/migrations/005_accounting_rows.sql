-- Exact, replaceable product projections. Raw snapshots remain per-pool evidence.
CREATE TABLE analytics_accounting_pools (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_id text NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version=1),
  through_block bigint NOT NULL CHECK (through_block>=0),
  through_hash text NOT NULL CHECK (through_hash ~ '^0x[0-9a-f]{64}$'),
  from_block bigint NOT NULL CHECK (from_block>=0 AND from_block<=through_block),
  from_timestamp bigint NOT NULL CHECK (from_timestamp>=0),
  asof_timestamp bigint NOT NULL CHECK (asof_timestamp>=from_timestamp),
  generated_at timestamptz NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('indexed','rpc_capture')),
  market jsonb NOT NULL CHECK (jsonb_typeof(market)='object' AND NOT market ? 'accounting' AND NOT market ? 'series'),
  holders_count integer CHECK (holders_count>=0),
  liquidity_wei numeric CHECK (liquidity_wei>=0 AND scale(liquidity_wei)=0),
  PRIMARY KEY(chain_id,pool_id),
  FOREIGN KEY(chain_id,pool_id) REFERENCES analytics_pool_snapshots ON DELETE CASCADE
);
CREATE TABLE analytics_accounting_positions (
  chain_id integer NOT NULL,
  pool_id text NOT NULL,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  supported boolean NOT NULL,
  flags text[] NOT NULL,
  quantity_raw numeric CHECK (quantity_raw>=0 AND scale(quantity_raw)=0),
  cost_wei numeric CHECK (cost_wei>=0 AND scale(cost_wei)=0),
  invested_wei numeric CHECK (invested_wei>=0 AND scale(invested_wei)=0),
  proceeds_wei numeric CHECK (proceeds_wei>=0 AND scale(proceeds_wei)=0),
  realized_wei numeric CHECK (scale(realized_wei)=0),
  unrealized_wei numeric CHECK (scale(unrealized_wei)=0),
  buys integer CHECK (buys>=0),
  sells integer CHECK (sells>=0),
  PRIMARY KEY(chain_id,pool_id,wallet),
  FOREIGN KEY(chain_id,pool_id) REFERENCES analytics_accounting_pools ON DELETE CASCADE,
  CHECK ((supported AND cardinality(flags)=0 AND quantity_raw IS NOT NULL AND cost_wei IS NOT NULL AND realized_wei IS NOT NULL AND invested_wei IS NOT NULL AND proceeds_wei IS NOT NULL AND buys IS NOT NULL AND sells IS NOT NULL)
    OR (NOT supported AND cardinality(flags)>0 AND quantity_raw IS NULL AND cost_wei IS NULL AND realized_wei IS NULL AND unrealized_wei IS NULL AND invested_wei IS NULL AND proceeds_wei IS NULL AND buys IS NULL AND sells IS NULL))
);
CREATE INDEX analytics_accounting_wallet_positions ON analytics_accounting_positions(chain_id,wallet,pool_id);
CREATE TABLE analytics_accounting_trades (
  chain_id integer NOT NULL,
  pool_id text NOT NULL,
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index>=0),
  block_number bigint NOT NULL CHECK (block_number>=0),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  eth_wei numeric NOT NULL CHECK (eth_wei>0 AND scale(eth_wei)=0),
  token_raw numeric NOT NULL CHECK (token_raw>0 AND scale(token_raw)=0),
  wallet text CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  execution jsonb CHECK (jsonb_typeof(execution)='object'),
  execution_supported boolean NOT NULL,
  realized_wei numeric CHECK (scale(realized_wei)=0),
  disposed_cost_wei numeric CHECK (disposed_cost_wei>=0 AND scale(disposed_cost_wei)=0),
  closed_gain_wei numeric CHECK (scale(closed_gain_wei)=0),
  closed_hold_seconds bigint CHECK (closed_hold_seconds>=0),
  PRIMARY KEY(chain_id,pool_id,transaction_hash,log_index),
  UNIQUE(chain_id,transaction_hash,log_index),
  FOREIGN KEY(chain_id,pool_id) REFERENCES analytics_accounting_pools ON DELETE CASCADE,
  FOREIGN KEY(chain_id,pool_id,wallet) REFERENCES analytics_accounting_positions ON DELETE CASCADE,
  CHECK ((wallet IS NULL)=(execution IS NULL)),
  CHECK (NOT execution_supported OR wallet IS NOT NULL),
  CHECK ((realized_wei IS NULL)=(disposed_cost_wei IS NULL)),
  CHECK (realized_wei IS NULL OR (side='sell' AND wallet IS NOT NULL AND realized_wei=eth_wei-disposed_cost_wei)),
  CHECK ((closed_gain_wei IS NULL)=(closed_hold_seconds IS NULL)),
  CHECK (closed_gain_wei IS NULL OR realized_wei IS NOT NULL)
);
CREATE INDEX analytics_accounting_wallet_trades ON analytics_accounting_trades(chain_id,wallet,timestamp DESC,block_number DESC,log_index DESC) WHERE wallet IS NOT NULL;
CREATE INDEX analytics_accounting_pool_trades ON analytics_accounting_trades(chain_id,pool_id,timestamp DESC);
CREATE INDEX analytics_accounting_realizations ON analytics_accounting_trades(chain_id,timestamp,wallet) INCLUDE(realized_wei,disposed_cost_wei,closed_gain_wei,closed_hold_seconds) WHERE realized_wei IS NOT NULL;
CREATE TABLE analytics_accounting_prices (
  chain_id integer NOT NULL,
  pool_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal>=0),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  price_wei numeric NOT NULL CHECK (price_wei>=0 AND scale(price_wei)=0),
  PRIMARY KEY(chain_id,pool_id,ordinal),
  FOREIGN KEY(chain_id,pool_id) REFERENCES analytics_accounting_pools ON DELETE CASCADE
);
CREATE INDEX analytics_accounting_price_window ON analytics_accounting_prices(chain_id,pool_id,timestamp DESC,ordinal DESC);
COMMENT ON TABLE analytics_accounting_positions IS 'Supported-position accounting only, exact integer average-cost basis from core foldTrades. Excluded positions persist with null finances and explicit flags.';
COMMENT ON TABLE analytics_accounting_trades IS 'Canonical observed swaps with optional audited execution. Sale gain includes historical carry basis; filter realization timestamp for windows without resetting inventory. Closure fields count complete inventory cycles.';
