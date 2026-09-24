import { Traders } from "@/components/traders";
import { rankedRowsScript } from "@/lib/ranked-rows";
export const metadata = { title: "Trader leaderboard" };
export default function Page() {
  return (
    <>
      {/* Reserves the leaderboard's row area from the URL before first paint;
          see rankedRowsScript for why the served shell cannot do it alone. */}
      <script dangerouslySetInnerHTML={{ __html: rankedRowsScript }} />
      <Traders />
    </>
  );
}
