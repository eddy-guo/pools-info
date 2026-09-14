import Link from "next/link";
export default function NotFound() {
  return (
    <div className="not-found">
      <div className="eyebrow">OUTSIDE THE SNAPSHOT</div>
      <h1>This page isn’t in our dataset.</h1>
      <p>
        The address may have activity beyond our current coverage. Explore a
        tracked pool or use wallet lookup.
      </p>
      <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
        <Link className="button" href="/">
          Explore pools
        </Link>
        <Link className="button secondary" href="/wallet/">
          Look up a wallet
        </Link>
      </div>
    </div>
  );
}
