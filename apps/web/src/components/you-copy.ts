/**
 * Every line the You page says, in one place, so a later synced mode swaps
 * the wording here without touching the page's markup. The lede is the one
 * sentence that says the lists live on this device (the header entry's
 * accessible name is the other place that says it); nothing else on the
 * page repeats a device or browser caveat.
 */
export const youCopy = {
  eyebrow: "SAVED ON THIS DEVICE",
  title: "You",
  lede: "Your watchlist and follows live in this browser only, with no account and nothing stored anywhere else.",
  identity: {
    chip: "YOU",
    prompt: "Set your wallet to see your rank and portfolio here",
    set: "Set my wallet",
    portfolio: "Portfolio",
    forget: "Forget this wallet",
    forgetShort: "Forget",
  },
  watchlist: {
    heading: "Watchlist",
    open: "Open in screener",
    copy: "Copy watchlist link",
    copied: "Watchlist link copied.",
    clipboard: "Clipboard unavailable. Select and copy the link below.",
    linkLabel: "Watchlist share link",
    subject: "Watchlist",
    empty: {
      title: "Your watchlist starts here",
      description: "Star a pool anywhere on Pools to save it here.",
      action: "Browse pools",
    },
    unserved: {
      title: "No watched pools to show",
      description:
        "None of your starred pools could be served. They stay in your watchlist.",
    },
    capped: (shown: number, saved: number) =>
      `Showing the first ${shown} starred pools; all ${saved} stay in your watchlist.`,
  },
  following: {
    heading: "Following",
    compare: "Compare on the leaderboard",
    unfollow: (address: string) => `Unfollow ${address}`,
    summaryPending: "Pending",
    summaryUnavailable: "unavailable",
    summaryQuiet: (window: string) => `no trades in ${window}`,
    empty: {
      title: "You are not following anyone yet",
      description:
        "Follow a wallet from the leaderboard or a wallet page to see it here.",
      action: "Open the leaderboard",
    },
  },
} as const;
