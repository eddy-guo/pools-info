import { notFound } from "next/navigation";
import { WalletView } from "@/components/details";
import { shortAddress } from "@pools/core";
import { cardQuery, parseCardOptions } from "@/lib/card-options";
type Props = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
export async function generateMetadata({ params, searchParams }: Props) {
  const { address } = await params;
  const q = await searchParams;
  const title = `${shortAddress(address)} · Wallet profile`;
  const description =
    "Realized PnL, ROI and win rate across Robinhood Chain pools on Pools Info.";
  const pool =
    typeof q.pool === "string" && /^0x[0-9a-f]{64}$/i.test(q.pool)
      ? q.pool
      : null;
  const launch =
    typeof q.launch === "string" && /^0x[0-9a-f]{64}$/i.test(q.launch)
      ? q.launch
      : null;
  // The preview image is the PnL card with the page's own window and card
  // options, so a shared link unfurls to the card the sender customised.
  const options = parseCardOptions(
    new URLSearchParams(
      Object.entries(q).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    ),
  );
  const image = `/cards/${address}.png?${cardQuery(
    options,
    pool && launch ? { pool, launch } : undefined,
  )}`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
export default async function Page({ params }: Props) {
  const { address } = await params;
  if (!/^0x[0-9a-f]{40}$/i.test(address)) notFound();
  return <WalletView address={address.toLowerCase()} />;
}
