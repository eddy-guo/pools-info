import { reader } from "@/lib/data";
import { WalletLookup } from "@/components/lookup";
export const metadata = { title: "Look up a wallet" };
export default async function LookupPage() {
  return <WalletLookup wallets={await reader.wallets()} />;
}
