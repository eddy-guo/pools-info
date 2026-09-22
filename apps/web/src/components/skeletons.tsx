import type { CSSProperties } from "react";
import styles from "./skeletons.module.css";
export function SkeletonLine({
  width = "100%",
  height = 12,
  className = "",
}: {
  width?: CSSProperties["width"];
  height?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-skeleton="line"
      className={`${styles.block} ${className}`}
      style={{ width, height }}
    />
  );
}
export function CoverageSkeleton() {
  return (
    <div aria-hidden="true" className={styles.coverage}>
      <SkeletonLine width="52%" />
      <SkeletonLine width="88%" height={9} />
    </div>
  );
}
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      className={`${styles.stats} ${count > 4 ? styles.eight : ""}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <div className={styles.stat} key={i}>
          <SkeletonLine width="58%" height={9} />
          <SkeletonLine width="73%" height={23} />
          <SkeletonLine width="82%" height={8} />
        </div>
      ))}
    </div>
  );
}
export function RowsSkeleton({
  rows = 6,
  label = "Loading rows",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      data-skeleton="rows"
      className={styles.rows}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div className={styles.row} key={i} aria-hidden="true">
          <SkeletonLine height={30} width={30} className={styles.avatar} />
          <div className={styles.stack}>
            <SkeletonLine width={i % 2 ? "68%" : "82%"} />
            <SkeletonLine width="52%" height={8} />
          </div>
          <SkeletonLine width="75%" />
          <SkeletonLine width="65%" />
          <SkeletonLine width="82%" />
        </div>
      ))}
    </div>
  );
}
export function ChartSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="chart" className={styles.chart}>
      {[38, 62, 51, 76, 68, 88, 74, 96].map((height, i) => (
        <SkeletonLine key={i} height={height + 70} />
      ))}
    </div>
  );
}
export function LaunchesSkeleton() {
  return (
    <div aria-hidden="true" className={styles.launches}>
      {[0, 1, 2, 3].map((i) => (
        <div className={styles.launch} key={i}>
          <SkeletonLine width="62%" />
          <SkeletonLine width="42%" height={8} />
          <SkeletonLine width="78%" height={17} />
        </div>
      ))}
    </div>
  );
}
export function LeaderboardSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading trader rankings"
      aria-busy="true"
      data-skeleton="leaderboard"
    >
      <div aria-hidden="true" className={styles.podium}>
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <SkeletonLine width={32} height={32} />
            <SkeletonLine width="82%" />
            <SkeletonLine width="62%" height={18} />
          </div>
        ))}
      </div>
      <RowsSkeleton label="Loading ranked traders" />
    </div>
  );
}
export function SearchSkeleton() {
  return (
    <div
      role="status"
      aria-label="Searching tokens and wallets"
      aria-busy="true"
      data-skeleton="search"
      className={styles.search}
    >
      {[0, 1, 2, 3].map((i) => (
        <div className={styles.row} key={i} aria-hidden="true">
          <SkeletonLine width={30} height={30} />
          <div className={styles.stack}>
            <SkeletonLine width={i % 2 ? "48%" : "68%"} />
            <SkeletonLine width="80%" height={9} />
          </div>
        </div>
      ))}
    </div>
  );
}
export function DetailSkeleton({
  kind = "wallet",
}: {
  kind?: "wallet" | "pool";
}) {
  return (
    <div
      className={styles.group}
      role="status"
      aria-label={`Loading ${kind} analytics`}
      aria-busy="true"
      data-skeleton={kind}
    >
      {kind === "wallet" && <StatsSkeleton count={5} />}
      <div className="workspace-grid">
        <div>
          <section className="panel">
            <div className={styles.controls}>
              <SkeletonLine width={180} height={18} />
            </div>
            <ChartSkeleton />
            {kind === "pool" && <StatsSkeleton count={6} />}
          </section>
          <section className="panel live-section">
            <div className={styles.controls}>
              <SkeletonLine width={82} height={26} />
              <SkeletonLine width={82} height={26} />
            </div>
            <RowsSkeleton rows={5} label={`Loading ${kind} activity`} />
          </section>
        </div>
        <aside className="market-sidebar">
          <section className="panel">
            <div className={styles.controls}>
              <SkeletonLine width={120} />
            </div>
            <RowsSkeleton rows={4} label="Loading supporting data" />
          </section>
        </aside>
      </div>
    </div>
  );
}
export function PageSkeleton({
  kind = "explore",
  title,
}: {
  kind?: "explore" | "wallet" | "pool" | "traders";
  title?: string;
}) {
  return (
    <div
      className="page"
      role="status"
      aria-label={`Loading ${kind} page`}
      aria-busy="true"
      data-skeleton="page"
    >
      <div className={styles.title}>
        {title ? <h1>{title}</h1> : <SkeletonLine width={220} height={30} />}
        <SkeletonLine width="min(360px,85%)" />
      </div>
      <CoverageSkeleton />
      {kind === "wallet" || kind === "pool" ? (
        <DetailSkeleton kind={kind} />
      ) : kind === "traders" ? (
        <section className="panel">
          <LeaderboardSkeleton />
        </section>
      ) : (
        <>
          <StatsSkeleton />
          <LaunchesSkeleton />
          <div className="workspace-grid">
            <section className="panel">
              <div className={styles.controls}>
                <SkeletonLine width={110} height={30} />
                <SkeletonLine width={150} height={30} />
              </div>
              <RowsSkeleton label="Loading pools" />
            </section>
            <aside className="market-sidebar">
              <section className="panel">
                <RowsSkeleton rows={4} label="Loading recent activity" />
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
