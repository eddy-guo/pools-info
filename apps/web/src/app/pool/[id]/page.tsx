import { notFound } from "next/navigation";
import { reader } from "@/lib/data";
import { PoolView } from "@/components/details";
export const dynamicParams = false;
export async function generateStaticParams() {
  return (await reader.pools({ pageSize: 100 })).items.map((p) => ({
    id: p.id,
  }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const p = await reader.pool((await params).id);
  return { title: p ? `${p.pool.name} (${p.pool.symbol})` : "Pool not found" };
}
export default async function PoolPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const detail = await reader.pool((await params).id);
  if (!detail) notFound();
  return <PoolView detail={detail} />;
}
