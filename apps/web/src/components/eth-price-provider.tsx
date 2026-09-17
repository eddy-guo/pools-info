"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { validateEthPriceResponse } from "@/lib/eth-price-response";

const REFRESH_MS = 60_000;
const Context = createContext<number | null>(null);

/**
 * Fetches the Coinbase-backed ETH/USD rate once per page load through the
 * read proxy, then re-fetches at most once a minute while the page stays
 * open. Never fabricates a rate: a failed or not-yet-resolved read leaves the
 * context `null`, and callers show ETH figures unchanged rather than guess.
 */
export function EthPriceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [usdPerEth, setUsdPerEth] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch("/api/product/prices/eth-usd/", {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw Error("price_unavailable");
        const data: unknown = await response.json();
        validateEthPriceResponse(data);
        if (!cancelled) setUsdPerEth(data.usdPerEth);
      } catch {
        if (!cancelled) setUsdPerEth(null);
      } finally {
        if (!cancelled) timer = setTimeout(load, REFRESH_MS);
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return <Context value={usdPerEth}>{children}</Context>;
}
export function useEthPrice() {
  return useContext(Context);
}
