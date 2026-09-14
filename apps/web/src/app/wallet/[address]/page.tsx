import { notFound } from "next/navigation";
import { WalletView } from "@/components/details";
import { shortAddress, windows } from "@pools/core";
type Props = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
export async function generateMetadata({ params, searchParams }: Props) {
  const { address } = await params;
  const q = await searchParams;
  const title = `${shortAddress(address)} · Wallet profile`;
  const description =
    "Real on-chain pool audit with explicit coverage. Gross swap PnL before gas; not wallet-wide returns.";
  const pool =
    typeof q.pool === "string" && /^0x[0-9a-f]{64}$/i.test(q.pool)
      ? q.pool
      : null;
  const launch =
    typeof q.launch === "string" && /^0x[0-9a-f]{64}$/i.test(q.launch)
      ? q.launch
      : null;
  const window =
    typeof q.window === "string" && Object.hasOwn(windows, q.window)
      ? q.window
      : "All";
  const image =
    pool && launch
      ? `/cards/${address}.png?${new URLSearchParams({ pool, launch, window })}`
      : undefined;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      ...(image
        ? { images: [{ url: image, width: 1200, height: 630, alt: title }] }
        : {}),
    },
    ...(image
      ? {
          twitter: {
            card: "summary_large_image",
            title,
            description,
            images: [image],
          },
        }
      : {}),
  };
}
export default async function Page({ params }: Props) {
  const { address } = await params;
  if (!/^0x[0-9a-f]{40}$/i.test(address)) notFound();
  return <WalletView address={address.toLowerCase()} />;
}
