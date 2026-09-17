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
  // A request renders once on the server, so its clock is the launch age's
  // basis on both sides of hydration.
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Math.floor(Date.now() / 1000);
  return <PoolDetail id={id.toLowerCase()} renderedAt={renderedAt} />;
}
