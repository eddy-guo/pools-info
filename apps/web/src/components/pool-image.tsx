"use client";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "./ui";
import styles from "./pool-image.module.css";

type Props = {
  poolId: string;
  token: string;
  hasImage: boolean;
  size?: "normal" | "small" | "large";
};

export function PoolImage(props: Props) {
  return <LazyPoolImage key={`${props.poolId}:${props.hasImage}`} {...props} />;
}

function LazyPoolImage({ poolId, token, hasImage, size = "normal" }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"pending" | "loaded" | "failed">(
    "pending",
  );
  useEffect(() => {
    if (!ref.current || !hasImage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [hasImage]);
  return (
    <span
      ref={ref}
      className={`${styles.root} ${styles[size]}`}
      aria-hidden="true"
      data-pool-image={poolId}
      data-image-state={state}
    >
      <Avatar address={token} small={size === "small"} />
      {visible && hasImage && state !== "failed" && (
        // The internal endpoint validates and re-encodes bytes. Creator URLs
        // never become a browser src; bypassing another optimizer avoids double work.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/token-image/${poolId.toLowerCase()}/`}
          alt=""
          width={128}
          height={128}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={state === "loaded" ? styles.loaded : styles.pending}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      )}
    </span>
  );
}
