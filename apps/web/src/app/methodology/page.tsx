import Link from "next/link";
export const metadata = { title: "Data and methodology" };
export default function Methodology() {
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">OPEN BOOKS, BETTER ANALYTICS</div>
          <h1>
            Behind the numbers<span className="title-dot">.</span>
          </h1>
          <p>
            Where the data comes from, what we verify, and the limits of each
            result.
          </p>
        </div>
      </div>
      <div className="prose-layout">
        <nav className="prose-nav" aria-label="Methodology sections">
          <a href="#coverage">01 · Sources and coverage</a>
          <a href="#prices">02 · Prices and volume</a>
          <a href="#accounting">03 · Profit and loss</a>
          <a href="#attribution">04 · Trader attribution</a>
          <a href="#limits">05 · What is unavailable</a>
        </nav>
        <article className="prose">
          <section id="coverage">
            <h2>01. Real events, bounded coverage</h2>
            <p>
              Market data comes directly from Robinhood Chain mainnet (chain ID
              4663) through its public RPC. We read Uniswap v4 PoolManager
              swaps, official instant-launch strategy events, transaction
              receipts, block headers, and token contracts. Explorer links
              provide evidence; the explorer does not supply our market data.
            </p>
            <p>
              The page initially loads a captured on-chain snapshot, then checks
              for updates about once a minute while visible. Successful server
              refreshes are cached for 60 seconds. When a refresh fails, the
              last captured data remains visible with a delayed-update notice.
              Capture time and source block always describe the displayed data.
            </p>
            <p>
              By default, we discover launches in the last 100,000 blocks and
              cover the newest eight supported instant pools, stopping discovery
              once enough launches are found. The displayed range is the actual
              scanned range. Each selected pool includes swaps from its launch
              through the common cutoff. This is a recent sample, not a
              chain-wide screener. The cutoff trails the scan head by 128
              blocks; that buffer is not a claim of L1 finality.
            </p>
            <p>
              Collection checks deployment code, successful launch receipts,
              PoolKey-derived pool IDs, event emitters, and block hashes. Only
              native ETH/token pools without hooks are included. The cutoff hash
              is checked again before publishing a snapshot.
            </p>
          </section>
          <section id="prices">
            <h2>02. Spot prices and observed volume</h2>
            <p>
              Prices are ETH per token, derived from the post-swap square-root
              price and token decimals. They describe pool spot price after
              execution, not the average execution price or a guaranteed quote
              for a new trade. The chart follows those observations.
            </p>
            <p>
              Volume sums the absolute ETH amount of each decoded swap. Counts
              represent swap events, so one transaction can contain multiple
              swaps. Windowed volume includes only observed swaps inside the
              selected period through the capture cutoff. Buy and sell
              directions follow token movement into or out of the pool.
            </p>
            <p>
              All values remain in ETH. No USD price feed or conversion rate is
              used. Token supply and metadata are read from contracts at the
              cutoff. The displayed LP fee is distinct from protocol fees and
              gas.
            </p>
          </section>
          <section id="interaction">
            <h2>Search, charts and live updates</h2>
            <p>
              Chart intervals group captured post-swap observations into fixed
              candles, independently of the visible range. FDV multiplies those
              prices by contract supply at the cutoff. Panning and trade
              pagination use loaded data; they do not imply complete historical
              coverage.
            </p>
            <p>
              The live feed checks a recent 1,000-block window every 15 seconds
              after the previous check completes, ending 128 blocks behind the
              head. It displays up to 50 returned events per check, with shared
              server caching and duplicate removal. Delays and omitted events
              are disclosed. Its transaction-sender label is not proof of the
              buyer, beneficiary or cost basis.
            </p>
            <p>
              Search matches covered tokens and audited activity. ENS resolution
              reads the standard Ethereum address record through PublicNode
              Ethereum RPC, caches successful results for five minutes, and
              opens that address on Robinhood. A resolved name does not prove
              Robinhood activity or a chain-specific ENS record. Offchain-only
              resolution is not enabled. No wallet authentication or account
              data is stored.
            </p>
          </section>
          <section id="accounting">
            <h2>03. Realized means sold</h2>
            <p>
              The on-demand trader audit covers one pool, with its own capture
              block and time. It uses average-cost accounting in integer wei and
              raw token units. Buys add inventory and cost; sells remove the
              proportional cost of the tokens sold.
            </p>
            <div className="formula">
              Realized PnL = sale proceeds − cost basis of tokens sold
            </div>
            <p>
              For example, buying 100 tokens for 1 ETH and selling 40 for 0.6
              ETH realizes +0.2 ETH. The remaining 60 tokens retain 0.6 ETH of
              cost. Rounding residue stays with inventory until the final sale.
            </p>
            <p>
              This is gross realized swap PnL before gas. Swap fees reflected in
              the pool’s execution amounts are not subtracted again. It does not
              establish total wallet returns, historical USD profit, or profit
              after every router or application-level fee.
            </p>
            <p>
              Unknown inventory or cost basis excludes a position from PnL. We
              never treat unknown acquired tokens as free. The audit’s
              eligibility filter requires complete supported positions with at
              least 10 swaps in that pool’s covered history. A small sample may
              have no eligible wallets.
            </p>
          </section>
          <section id="performance">
            <h2>Windowed performance and behaviour</h2>
            <p>
              Windowed realized PnL carries cost basis from the pool’s full
              audited history, then sums only sales realized inside the selected
              window. Net ETH instead subtracts purchases from proceeds inside
              that window, including spending on inventory still held.
            </p>
            <p>
              Realized ROI divides profit by the cost of tokens sold. A win or
              loss is a fully closed inventory cycle; break-even cycles are
              omitted from win rate. Average hold measures first buy to closing
              sell for closed cycles in the window. Best sale is the largest
              individual realized disposal, not a hypothetical peak price.
            </p>
            <p>
              Open inventory is marked at the latest observed price in the same
              audit, so its balance and price share a cutoff. Refresh the audit
              to update that mark. Early-buy share measures supported token
              purchase quantity in the first five blocks after launch divided by
              supported buy quantity in the selected window.
            </p>
            <p>
              The minimum-swap gate supports 10, 25 or 100. No-purchase,
              oversold and under-60-second closed-hold filters are visible.
              Unknown-basis and unsupported positions always remain excluded; a
              blacklist filter is unavailable because no such source is
              connected.
            </p>
          </section>
          <section id="attribution">
            <h2>04. Addresses need evidence</h2>
            <p>
              A transaction sender alone is not proof of the trader. Audits
              check complete receipts, supported router/token flows, ERC-20
              transfers, sender contract code, and token balances at the audit
              cutoff. Transfers are reconciled against tracked inventory.
            </p>
            <p>
              Unsupported routes, contract senders, unmatched transfers, and
              balance or inventory mismatches are shown as exclusions. These
              conservative checks do not identify every bot or prove that
              trading is organic. An address is not a verified person.
            </p>
            <p>
              The launch sender is labeled as such. The launch event’s final
              position recipient can be a fee-splitting contract and must not
              automatically be labeled the creator.
            </p>
          </section>
          <section id="limits">
            <h2>05. Coverage before rankings</h2>
            <p>
              Wallet profiles and share cards use one audited pool at a time.
              Creator pages group covered launches by transaction sender. Global
              trader rankings, complete wallet histories, holder concentration,
              reserve-based liquidity, USD metrics, and crowd-auction accounting
              still need verified inputs and sufficient history.
            </p>
            <p>
              Refreshes are bounded RPC scans, not a persistent indexer. Busy
              pools or provider limits can prevent an audit from completing. A
              failed refresh keeps the last successful result instead of
              publishing partial totals. A durable worker can extend history
              later while reusing the ingestion and accounting code.
            </p>
            <Link className="button" href="/">
              Back to markets
            </Link>
          </section>
        </article>
      </div>
    </div>
  );
}
