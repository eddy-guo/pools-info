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
            What we measure, what we exclude, and what this snapshot can tell
            you.
          </p>
        </div>
      </div>
      <div className="prose-layout">
        <nav className="prose-nav" aria-label="Methodology sections">
          <a href="#coverage">01 · Data coverage</a>
          <a href="#accounting">02 · Profit and loss</a>
          <a href="#ranking">03 · Ranking rules</a>
          <a href="#prices">04 · Prices and inventory</a>
          <a href="#identity">05 · Identity and creators</a>
          <a href="#limits">06 · What comes next</a>
        </nav>
        <article className="prose">
          <section id="coverage">
            <h2>01. This is a demo snapshot</h2>
            <p>
              <strong>
                Every token, wallet, transaction, price, and liquidity value
                shown here is simulated.
              </strong>{" "}
              This version lets you explore the product without connecting a
              wallet, subscribing to an API, or running a backend.
            </p>
            <p>
              The deterministic dataset contains 12 pools, 8 wallets, and 1,536
              trades from September 7 to September 14, 2026. The cutoff is
              September 14 at 06:00 UTC. Dates and “age” labels refer to that
              fixed cutoff, not the current time.
            </p>
            <p>
              The data is not live and does not represent activity of the
              corresponding addresses on any chain. Explorer links are omitted
              for simulated addresses. A later verified snapshot must record its
              sources, block range, and reconciliation evidence.
            </p>
          </section>
          <section id="accounting">
            <h2>02. Realized means sold</h2>
            <p>
              We use average-cost accounting for each wallet and pool. Buys add
              tokens and ETH cost to inventory. A sale removes the proportional
              cost of the tokens sold. The difference between proceeds and that
              cost is realized PnL.
            </p>
            <div className="formula">
              Realized PnL = sale proceeds − cost basis of tokens sold
            </div>
            <p>
              For example, buy 100 tokens for 1 ETH, then sell 40 for 0.6 ETH.
              Their cost basis is 0.4 ETH, so realized PnL is{" "}
              <strong>+0.2 ETH</strong>. The remaining 60 tokens retain a cost
              basis of 0.6 ETH.
            </p>
            <p>
              <strong>Net ETH flow is different.</strong> Proceeds minus all
              purchases in the same window includes the cost of unsold
              inventory. We do not label that number realized profit.
            </p>
            <p>
              For a 24-hour result, we carry cost basis from earlier trades in
              the full snapshot and sum only realized sale events inside the
              last 24 hours. All simulated wallets start with zero tracked
              inventory. A real snapshot cannot assume zero opening inventory
              without evidence.
            </p>
            <p>
              All accounting uses integer wei and raw token units. Rounding
              residue stays with remaining inventory and is removed on the final
              sale. Gas is excluded. Swap fees are already reflected in the
              simulated execution amounts; they are not subtracted again.
            </p>
          </section>
          <section id="ranking">
            <h2>03. A leaderboard with boundaries</h2>
            <ul>
              <li>
                Rank on realized PnL in ETH, with at least 10 buy/sell legs in
                instant pools during the selected window.
              </li>
              <li>
                Exclude crowd-launch pools from the ranked total until auction
                entry costs can be verified.
              </li>
              <li>
                A sale exceeding known inventory makes the position’s basis
                unknown. The wallet is ineligible for ranking rather than
                receiving zero-cost profit.
              </li>
              <li>
                Win rate counts currently closed wallet-pool positions whose
                last closure falls inside the selected window. Profitable
                positions are wins, unprofitable positions are losses, and
                break-even positions are omitted.
              </li>
              <li>
                A position table can include crowd-pool simulated swap PnL. The
                ranked total excludes it, so the sum of every position need not
                equal the ranked number.
              </li>
            </ul>
            <p>
              Volume is the sum of ETH amounts on buys and sells. Trade counts
              represent swap legs, not unique transactions or humans. Rankings
              do not establish skill or rule out wash trading.
            </p>
          </section>
          <section id="prices">
            <h2>04. Prices are observations</h2>
            <p>
              Charts use ETH-per-token execution prices derived from the
              simulated swaps. The last price marks tracked inventory. The fully
              diluted value multiplies that price by total supply.
            </p>
            <p>
              <strong>
                Unrealized PnL is an estimate, not guaranteed exit proceeds.
              </strong>{" "}
              Slippage, thin liquidity, transfers, and unknown basis can make a
              wallet’s actual position different. “Tracked inventory” describes
              our swap ledger, not an independently verified token balance.
            </p>
            <p>
              The USD toggle applies one simulated ETH/USD rate of $2,356.80 to
              ETH-denominated values. It is a display conversion, not historical
              dollar PnL.
            </p>
            <p>
              Holder distribution is deliberately unavailable. ERC-20 balances
              need independent enrichment, and protocol-held tokens must be
              excluded when calculating adjusted concentration.
            </p>
          </section>
          <section id="identity">
            <h2>05. Addresses, not assumptions</h2>
            <p>
              Wallet names such as quietcapital are demo labels, not ENS names
              or verified identities. Creator pages group the simulated pool
              creation relationships; they are not endorsements or risk scores.
            </p>
            <p>
              When real indexing is added, transaction senders will need
              qualification. A direct EOA’s transaction sender is useful
              evidence, but relayers, smart wallets, and bundlers can represent
              someone else. Unsupported attribution must be flagged.
            </p>
          </section>
          <section id="limits">
            <h2>06. What comes next</h2>
            <p>
              The site reads through a shared analytics interface. A bounded
              real snapshot can replace this dataset, followed by a durable
              indexer and database without rebuilding the screens.
            </p>
            <p>
              Real indexing must verify contract deployments and ABIs, swap
              signs, decimals, event uniqueness, and canonical block history. A
              wallet reconciliation is the gate before publishing actual ranked
              performance.
            </p>
            <p>
              Broader history, live updates, verified holders, and auction
              analytics depend on that data work. This preview does not claim
              those capabilities.
            </p>
            <Link className="button" href="/">
              Back to pools
            </Link>
          </section>
        </article>
      </div>
    </div>
  );
}
