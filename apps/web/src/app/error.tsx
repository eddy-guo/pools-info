"use client";
import Link from "next/link";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="not-found">
      <h1>We couldn’t load this view.</h1>
      <p>Try again, or return to the markets.</p>
      <button className="button" onClick={reset}>
        Try again
      </button>
      <Link className="button secondary" style={{ marginLeft: 10 }} href="/">
        Back to markets
      </Link>
    </div>
  );
}
