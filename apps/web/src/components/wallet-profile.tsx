"use client";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserRound } from "lucide-react";
import { shortAddress } from "@pools/core";
import { useProfileStore } from "@/lib/profile-store";
import { Avatar } from "./ui";
import { isWalletAddress } from "./my-wallet";
import { SavedCountBadge, useSavedCount } from "./saved-count";

/** The one way this browser marks a wallet as its own: a typed address,
    saved like the follow list, with no connection and no signature. The
    You page opens it from its identity row. It opens on the address field,
    and every dismissal goes through the native close, which hands focus
    back to the control that opened it before `onClose` unmounts it. */
export function SetWalletDialog({
  onClose,
  onSet,
}: {
  onClose: () => void;
  onSet: (address: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = value.trim();
    if (!isWalletAddress(address)) {
      setInvalid(true);
      return;
    }
    onSet(address);
  }
  return (
    <dialog
      ref={dialog}
      className="wallet-set-dialog"
      aria-labelledby="wallet-set-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current.close();
      }}
    >
      <form onSubmit={submit}>
        <div className="wallet-set-head">
          <h2 id="wallet-set-title">Set my wallet</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <label htmlFor="wallet-set-address">Your wallet address</label>
        <input
          ref={input}
          id="wallet-set-address"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={invalid ? "wallet-set-error" : undefined}
        />
        {invalid && (
          <p id="wallet-set-error" role="alert" className="wallet-set-error">
            Enter a valid 0x address.
          </p>
        )}
        <button type="submit" className="button">
          Use this wallet
        </button>
      </form>
    </dialog>
  );
}

/**
 * The header's entry into what this browser keeps for itself: one
 * persistent link to the You page in the slot a connect button would take,
 * reading "You" until a wallet is marked and the wallet's identity chip
 * after, with the saved count beside either. The box is one fixed size in
 * both states, so marking a wallet or saving something moves nothing beside
 * it; the count mounts after hydration as its own node inside that box. The
 * page it opens is where a wallet is marked or forgotten, so no menu or
 * dialog hangs off the header.
 */
export function WalletProfileEntry() {
  const { address } = useProfileStore();
  const { watch, follow, total } = useSavedCount();
  const pathname = usePathname();
  const here = pathname === "/you" || pathname.startsWith("/you/");
  return (
    <div className="wallet-profile-entry">
      <Link
        href="/you/"
        className={address ? "connect-button wallet-chip" : "connect-button"}
        aria-label={
          total
            ? `You: ${watch} watched, ${follow} followed`
            : "You: nothing saved yet"
        }
        aria-current={here ? "page" : undefined}
        title={address ? shortAddress(address) : undefined}
      >
        {/* Keyed apart: hydration swaps the label for the chip as new nodes,
            never by rewriting the label's text in place, which Chrome would
            score as the text's start moves inside the centred box. */}
        {address ? (
          <Fragment key="chip">
            <Avatar address={address} />
            <span className="wallet-chip-address mono">
              {shortAddress(address)}
            </span>
          </Fragment>
        ) : (
          <Fragment key="you">
            <UserRound size={15} />
            <span className="connect-label">You</span>
          </Fragment>
        )}
        <SavedCountBadge count={total} />
      </Link>
    </div>
  );
}
