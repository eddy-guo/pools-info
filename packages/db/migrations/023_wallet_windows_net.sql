-- Match the realized index's eligibility predicate so the net leaderboard
-- can stop at the requested page instead of sorting the whole window.
CREATE INDEX agg_wallet_windows_net ON agg_wallet_windows (chain_id, "window", net_wei DESC)
  WHERE supported_trades>=10 AND supported_positions>0;
