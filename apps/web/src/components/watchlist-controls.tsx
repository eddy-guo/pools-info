"use client";
import { useState } from "react";
import {
  MAX_SHARED_POOLS,
  MAX_WATCHLIST_QUERY_POOLS,
  watchlistShareUrl,
  type SharedWatchlist,
} from "@/lib/watchlist";

type Props = {
  ids: string[];
  shared: SharedWatchlist | null;
  query: string;
  save: (ids: readonly string[]) => boolean;
  openPersonal: () => void;
};

export function WatchlistControls({
  ids,
  shared,
  query,
  save,
  openPersonal,
}: Props) {
  const key = `${shared ? "shared" : "personal"}:${ids.join(",")}:${query}`;
  const [feedback, setFeedback] = useState({ key: "", message: "", link: "" });
  const current = feedback.key === key ? feedback : null;
  const tooMany = ids.length > MAX_SHARED_POOLS;
  return (
    <section
      className="watchlist-sync"
      aria-label={shared ? "Shared watchlist" : "Saved watchlist"}
    >
      <div style={{ minWidth: 0 }}>
        <strong>
          {shared ? "Shared watchlist" : "Your watchlist"} · {ids.length} pools
        </strong>
        <small>
          {shared
            ? "Stars change only your saved list. This link does not save anything automatically."
            : "Saved in this browser. Share a link to these pools with the current filters."}
        </small>
        {shared?.error && (
          <p className="panel-footnote" role="alert">
            {shared.error}
          </p>
        )}
        {!shared && ids.length > MAX_WATCHLIST_QUERY_POOLS && (
          <p className="panel-footnote">
            Showing the first {MAX_WATCHLIST_QUERY_POOLS} saved pools. All{" "}
            {ids.length} remain saved in this browser.
          </p>
        )}
        {tooMany && (
          <p className="panel-footnote">
            Share links support up to {MAX_SHARED_POOLS} pools. Your full list
            remains saved locally.
          </p>
        )}
        <small role="status" aria-live="polite">
          {current?.message ?? ""}
        </small>
        {current?.link && (
          <label>
            Share link
            <input
              aria-label="Watchlist share link"
              readOnly
              value={current.link}
              style={{ display: "block", width: "100%", minWidth: 0 }}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        )}
      </div>
      <div className="live-controls">
        <button
          className="button secondary"
          disabled={!ids.length || tooMany || !!shared?.error}
          onClick={async () => {
            let link = "";
            try {
              link = watchlistShareUrl(window.location.href, ids);
              await navigator.clipboard.writeText(link);
              setFeedback({ key, message: "Watchlist link copied.", link: "" });
            } catch (error) {
              setFeedback({
                key,
                message: link
                  ? "Clipboard unavailable. Select and copy the link below."
                  : error instanceof Error
                    ? error.message
                    : "Unable to create this link.",
                link,
              });
            }
          }}
        >
          Copy watchlist link
        </button>
        {shared && (
          <>
            <button
              className="button"
              disabled={!ids.length || !!shared.error}
              onClick={() =>
                setFeedback({
                  key,
                  message: save(ids)
                    ? "Shared pools saved to this browser's watchlist."
                    : "This browser could not save the watchlist. Your shared link still works.",
                  link: "",
                })
              }
            >
              Save to my watchlist
            </button>
            <button className="text-button" onClick={openPersonal}>
              My watchlist
            </button>
          </>
        )}
      </div>
    </section>
  );
}
