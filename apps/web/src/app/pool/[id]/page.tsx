import { notFound } from "next/navigation";
import { PoolDetail } from "@/components/pool-detail";
export const metadata = { title: "Pool detail" };
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^0x[0-9a-f]{64}$/i.test(id)) notFound();
  return <PoolDetail id={id.toLowerCase()} />;
}
