import { notFound } from "next/navigation";
import { reader } from "@/lib/data";
import { WalletView } from "@/components/details";
export const dynamicParams = false;
export async function generateStaticParams() {
  return (await reader.wallets()).map((w) => ({ address: w.address }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const detail = await reader.wallet(address);
  if (!detail) return { title: "Wallet not found" };
  const title = `${detail.wallet.label} · Demo performance`;
  const description =
    "Simulated seven-day trading performance. Not real wallet activity.";
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [
        { url: `/cards/${address}.png`, width: 1200, height: 630, alt: title },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`/cards/${address}.png`],
    },
  };
}
export default async function WalletPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const address = (await params).address;
  const [detail, leaders] = await Promise.all([
    reader.wallet(address),
    reader.leaderboard("7d", 1, 100),
  ]);
  if (!detail) notFound();
  const index = leaders.items.findIndex((w) => w.address === address);
  return <WalletView detail={detail} rank={index < 0 ? null : index + 1} />;
}
