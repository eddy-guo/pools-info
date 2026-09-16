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
          <p>Sources, evidence tiers, and the limits of each result.</p>
        </div>
      </div>
      <div className="prose-layout">
        <nav className="prose-nav" aria-label="Methodology sections">
          <a href="#coverage">01 · Sources and coverage</a>
          <a href="#prices">02 · Prices and volume</a>
          <a href="#accounting">03 · Profit and loss</a>
          <a href="#attribution">04 · Evidence tiers</a>
          <a href="#limits">05 · What is unavailable</a>
        </nav>
        <article className="prose">
          <section id="coverage">
            <h2>01. Discovered launches and market evidence</h2>
            <p>
              The launch explorer includes all discovered pools in our saved
              catalog. Discovery verifies official Pools launch events on
              Robinhood Chain, their transaction receipts, pool identities and
              source blocks. It does not include every token on the chain or
              establish that historical discovery is finished.
            </p>
            <p>
              Market metrics and trader rankings cover a smaller set with stored
              trading evidence. The pages state both counts and their data
              cutoffs. Deep collection prioritizes observed ETH volume and
              comparable ETH liquidity, with rotation so less active pools can
              still make progress. A high share of recorded volume does not
              prove the same share of all market volume.
            </p>
            <p>
              Collectors read chain events through RPC and save validated
              evidence in Postgres. Pages read saved results through our API.
              Repeated page visits do not each scan blockchain history. A
              labeled preload can remain available if the hosted reader cannot
              be reached. Discovery, recent activity and per-pool accounting
              have different coverage ranges.
            </p>
          </section>
          <section id="prices">
            <h2>02. Prices, volume and charts</h2>
            <p>
              Prices are ETH per token, derived from a swap&apos;s square-root
              pool price and known token units. These are post-swap spot
              observations, not execution quotes. Candles group recorded
              observations into time buckets; their volume is the sum of
              observed ETH swap amounts in each bucket.
            </p>
            <p>
              Volume counts swap events. One transaction may include several
              swaps. Launch time is the explorer&apos;s default sort because
              every discovered pool has it. Volume, liquidity and price-change
              sorts include only pools where the selected value is known. A
              known zero is retained; missing data is never turned into zero.
            </p>
            <p>
              Selected time windows end at the displayed evidence cutoff.
              Incomplete history, different pool cutoffs, missing token units
              and unavailable price marks remain explicit. Live activity shows
              newly stored trades as they become available; it is not a
              guarantee of every chain transaction or immediate finality.
            </p>
          </section>
          <section id="accounting">
            <h2>03. Average-cost realized PnL</h2>
            <p>
              Buys add token quantity and their exact ETH cost to a position. A
              sale disposes of the corresponding share of average cost. Realized
              PnL is sale proceeds minus that disposed cost. Token quantities
              and ETH wei use integer arithmetic; displayed rounded amounts do
              not feed the calculation.
            </p>
            <p>
              A trailing window filters the time of sales, not the history
              needed to price them. Earlier buys still carry their cost into
              later sales. Unknown opening inventory, a sale larger than the
              modeled position, or conflicting evidence prevents a defensible
              realized result. We do not invent opening buys or treat missing
              basis as zero.
            </p>
            <p>
              The leaderboard defaults to seven days and applies its
              minimum-trade gate to eligible positions. Profiles and cards use
              the same accounting source for the same wallet and selected
              window. Net ETH flow is proceeds minus spending during the window;
              it is different from realized profit. Gas is not deducted.
            </p>
          </section>
          <section id="attribution">
            <h2>04. What each evidence label means</h2>
            <p>
              The leaderboard can combine transfer-verified positions and
              explicitly flagged swap-based estimates. Coverage counts and each
              wallet&apos;s evidence label identify the histories actually
              included. A verified pool&apos;s complete book takes precedence
              over its swap-only copies, so the same trades never count in both
              tiers.
            </p>
            <p>
              <strong>Swap-based estimate (tier 2):</strong> recorded swaps and
              transaction initiators support an explicitly flagged trading
              model. It assumes the observed initiator&apos;s trades describe
              that modeled position. Transfer history and final token ownership
              have not been verified, so the model is not proof of a
              wallet&apos;s holdings or of the recipient of a routed trade.
              Unknown basis remains excluded.
            </p>
            <p>
              <strong>Transfer-verified (tier 3):</strong> retained
              token-transfer evidence also supports attribution and position
              reconciliation. Per-position flags can still exclude an individual
              result. A pool&apos;s verified-history badge describes its history
              checks, not a promise that every trader position qualifies.
            </p>
            <p>
              <strong>Mixed evidence:</strong> a wallet can have eligible
              positions in both tiers. Its row and profile disclose that
              combination. Any shown unrealized subtotal uses verified positions
              only; the swap model does not establish a live wallet balance.
            </p>
            <p>
              Retained source batches and block hashes govern validity.
              Rewinding a source invalidates dependent evidence. Duplicate
              copies of the same transaction log must not multiply volume or
              PnL.
            </p>
          </section>
          <section id="limits">
            <h2>05. Coverage is part of the result</h2>
            <p>
              Wallet addresses are public chain identities, not signed-in
              accounts. Account-synced watchlists, editable profiles and
              copy-trading execution are not implemented. Local watchlists do
              not establish a wallet connection.
            </p>
            <p>
              Search covers saved launches and observed activity. Finding an
              address is not evidence that its complete trade history is
              available. Creators, traders and holders are different
              relationships; a launch sender is not automatically a verified
              owner or a profitable trader.
            </p>
            <p>
              Missing values stay unavailable. Crowd-launch cost basis is not
              synthesized without clearing-price evidence. A ranked row is a
              result within the displayed evidence and window, not an all-chain
              or all-time profit claim.
            </p>
            <Link className="button" href="/">
              Explore discovered pools →
            </Link>
          </section>
        </article>
      </div>
    </div>
  );
}
