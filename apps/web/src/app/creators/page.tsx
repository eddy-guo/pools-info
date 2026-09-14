import { reader } from "@/lib/data";
import { Creators } from "@/components/creators";
export const metadata = { title: "Creator profiles" };
export default async function CreatorsPage() {
  return <Creators creators={await reader.creators()} />;
}
