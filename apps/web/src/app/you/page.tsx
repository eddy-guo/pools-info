import { YouPage } from "@/components/you";
import { youPrepaintScript } from "@/lib/saved";
export const metadata = { title: "You" };
export default function Page() {
  return (
    <>
      {/* Sizes each section's reserved rows from this browser's lists before
          first paint; see youPrepaintScript for why the served shell cannot. */}
      <script dangerouslySetInnerHTML={{ __html: youPrepaintScript }} />
      <YouPage />
    </>
  );
}
