/** Shared evidence/publication eligibility for saved attributed activity. */
export const verifiedActivityFrom = `FROM analytics_accounting_trades t
        JOIN analytics_accounting_positions position USING(chain_id,pool_id,wallet)
        JOIN analytics_accounting_pools a USING(chain_id,pool_id)
        JOIN analytics_pool_snapshots s USING(chain_id,pool_id)
        JOIN indexed_pools p USING(chain_id,pool_id)`;
export const verifiedActivityConditions = `t.chain_id=4663 AND t.execution_supported
          AND position.supported AND cardinality(position.flags)=0
          AND a.through_block=s.through_block AND a.through_hash=s.through_hash
          AND a.generated_at=s.generated_at AND a.asof_timestamp=s.asof_timestamp
          AND a.from_block=p.launch_block AND a.market->>'id'=p.pool_id
          AND a.market->>'token'=p.token
          AND t.block_number BETWEEN a.from_block AND a.through_block
          AND t.timestamp BETWEEN a.from_timestamp AND a.asof_timestamp
          AND NOT EXISTS (SELECT 1 FROM recent_pools r WHERE r.chain_id=p.chain_id AND r.pool_id=p.pool_id
            AND (r.token,r.launch_block,r.launch_tx,r.launch_sender,r.launched_at)
              IS DISTINCT FROM (p.token,p.launch_block,p.launch_tx,p.launch_sender,p.launched_at))`;
