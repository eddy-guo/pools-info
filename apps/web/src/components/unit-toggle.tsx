"use client";
import { useUnit } from "./state";
import { useEthPrice } from "./eth-price-provider";

/** The export's segmented control (32px frame, 26px buttons), reused as-is.
 * USD stays selectable even while the price read is unavailable; only its
 * accessible name notes that, so a screen reader user is not left guessing
 * why the figures did not change. */
export function UnitToggle() {
  const { unit, setUnit } = useUnit();
  const usdPerEth = useEthPrice();
  return (
    <div className="segmented unit-toggle" aria-label="Currency unit">
      <button
        type="button"
        aria-pressed={unit === "ETH"}
        className={unit === "ETH" ? "selected" : ""}
        onClick={() => setUnit("ETH")}
      >
        ETH
      </button>
      <button
        type="button"
        aria-pressed={unit === "USD"}
        className={unit === "USD" ? "selected" : ""}
        aria-label={usdPerEth === null ? "USD, price unavailable" : undefined}
        onClick={() => setUnit("USD")}
      >
        USD
      </button>
    </div>
  );
}
