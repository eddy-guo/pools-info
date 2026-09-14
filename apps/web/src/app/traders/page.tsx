import { reader } from "@/lib/data";
import { Traders } from "@/components/traders";
export const metadata = { title: "Trader leaderboard" };
export default async function TradersPage() {
  const [day, week] = await Promise.all([
    reader.leaderboard("24h", 1, 100),
    reader.leaderboard("7d", 1, 100),
  ]);
  return <Traders rows={{ "24h": day.items, "7d": week.items }} />;
}
