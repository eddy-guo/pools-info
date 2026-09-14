import { notFound } from "next/navigation";
import { Creators } from "@/components/creators";
export const metadata = { title: "Creator launch profile" };
export default async function Page({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (!/^0x[0-9a-f]{40}$/i.test(address)) notFound();
  return <Creators address={address.toLowerCase()} />;
}
