"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { shortAddress, walletHref } from "@pools/core";
import { Avatar } from "./ui";
import { useMyWallet, isWalletAddress } from "./my-wallet";
import { PnlCardModal } from "./pnl-card-modal";

function SetWalletDialog({
  onClose,
  onSet,
}: {
  onClose: () => void;
  onSet: (address: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
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
        if (event.target === dialog.current) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="wallet-set-head">
          <h2 id="wallet-set-title">Set my wallet</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <label htmlFor="wallet-set-address">Your wallet address</label>
        <input
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
        <p className="wallet-set-note">
          Saved only in this browser. No connection is made.
        </p>
      </form>
    </dialog>
  );
}

function WalletMenu({
  address,
  triggerRef,
  onClose,
  onShare,
  onForget,
}: {
  address: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onShare: () => void;
  onForget: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !triggerRef.current?.contains(target))
        onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose, triggerRef]);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label="Wallet menu"
      className="wallet-menu"
    >
      <Link
        role="menuitem"
        className="wallet-menu-item"
        href={walletHref(address)}
        onClick={onClose}
      >
        Portfolio
      </Link>
      <Link
        role="menuitem"
        className="wallet-menu-item"
        href="/traders/?view=following"
        onClick={onClose}
      >
        Following
      </Link>
      <Link
        role="menuitem"
        className="wallet-menu-item"
        href="/?view=watchlist"
        onClick={onClose}
      >
        Watchlist
      </Link>
      <button
        type="button"
        role="menuitem"
        className="wallet-menu-item"
        onClick={onShare}
      >
        Share PnL card
      </button>
      <button
        type="button"
        role="menuitem"
        className="wallet-menu-item wallet-menu-forget"
        onClick={onForget}
      >
        Forget this wallet
      </button>
    </div>
  );
}

/**
 * The header's entry into the one wallet this browser calls its own: no
 * connection or signing, just PR 67's my-wallet store surfaced where a real
 * connect button would sit. One trigger button persists across both states
 * so its reserved box and keyboard focus never move when the wallet changes.
 */
export function WalletProfileEntry() {
  const { address, set, available } = useMyWallet();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  function closeMenu() {
    setMenuOpen(false);
    trigger.current?.focus();
  }
  return (
    <div className="wallet-profile-entry">
      <button
        ref={trigger}
        type="button"
        className={address ? "connect-button wallet-chip" : "connect-button"}
        disabled={!available}
        aria-haspopup={address ? "menu" : "dialog"}
        aria-expanded={address ? menuOpen : undefined}
        aria-label={
          address ? `Wallet menu, ${shortAddress(address)}` : "Set my wallet"
        }
        onClick={() =>
          address ? setMenuOpen((open) => !open) : setDialogOpen(true)
        }
      >
        {address ? (
          <>
            <Avatar address={address} />
            <span className="wallet-chip-address mono">
              {shortAddress(address)}
            </span>
          </>
        ) : (
          <>
            <Wallet size={15} />
            <span className="connect-label">Set my wallet</span>
          </>
        )}
      </button>
      {address && menuOpen && (
        <WalletMenu
          address={address}
          triggerRef={trigger}
          onClose={closeMenu}
          onShare={() => {
            closeMenu();
            setShareOpen(true);
          }}
          onForget={() => {
            closeMenu();
            set("");
          }}
        />
      )}
      {dialogOpen && (
        <SetWalletDialog
          onClose={() => setDialogOpen(false)}
          onSet={(next) => {
            set(next);
            setDialogOpen(false);
          }}
        />
      )}
      {address && (
        <PnlCardModal
          address={address}
          window="All"
          open={shareOpen}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
