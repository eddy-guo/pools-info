import { reader } from "@/lib/data";
import { Overview } from "@/components/overview";
export default async function HomePage() {
  const [pools, recent, leaders] = await Promise.all([
    reader.pools({ pageSize: 100 }),
    reader.recentTrades(6),
    reader.leaderboard("7d"),
  ]);
  return (
    <Overview pools={pools.items} recent={recent} leaders={leaders.items} />
  );
}
