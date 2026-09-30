"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FollowedWallets } from "./following";
export function WalletLookup() {
  const [address, setAddress] = useState(""),
    [error, setError] = useState("");
  const router = useRouter();
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">NO ACCOUNT REQUIRED</div>
          <h1>
            Look up a wallet<span className="title-dot">.</span>
          </h1>
        </div>
      </div>
      <form
        className="panel live-lookup"
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^0x[0-9a-f]{40}$/i.test(address.trim())) {
            setError(
              "Enter a 42-character Ethereum address. ENS resolution is not connected yet.",
            );
            return;
          }
          router.push(`/wallet/${address.trim().toLowerCase()}/`);
        }}
      >
        <label htmlFor="wallet-address">Wallet address</label>
        <input
          id="wallet-address"
          name="address"
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoComplete="off"
        />
        <button className="button">Open wallet profile</button>
        {error && <p role="alert">{error}</p>}
      </form>
      <FollowedWallets />
    </div>
  );
}
