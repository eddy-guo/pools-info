import Link from "next/link";
export default function NotFound() {
  return (
    <div className="not-found">
      <div className="eyebrow">PAGE NOT FOUND</div>
      <h1>This page isn’t available.</h1>
      <Link className="button" href="/">
        Back to markets
      </Link>
    </div>
  );
}
