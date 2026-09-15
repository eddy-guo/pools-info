import {
  decodeEventLog,
  encodeAbiParameters,
  parseAbiItem,
  toEventSelector,
} from "viem";
import type { RawLog } from "./events";

// Official UERC20Factory v2.0.0 source: Uniswap/uerc20-factory at
// de5bacd215f6aae50e524297c18fcf78b69b6312. ITokenFactory.sol declares a
// NON-indexed tokenAddress; UERC20MetadataLibrary.sol supplies this tuple order.
// This is a different emitter/signature from LiquidityLauncher's TokenCreated.
export const tokenMetadataFactory =
  "0x000000e200088d55c39a11f609e5f667729ad49b";
export const tokenMetadataEvent = parseAbiItem(
  "event TokenCreated(address tokenAddress, (string description, string website, string image, bytes extraData) metadata)",
);
export const tokenMetadataTopic = toEventSelector(tokenMetadataEvent);
export const tokenMetadataLimits = {
  eventBytes: 65536,
  descriptionCharacters: 4000,
  urlCharacters: 2048,
} as const;

export type TokenMetadataIssue =
  | "unsupported_metadata_source"
  | "metadata_event_too_large"
  | "malformed_metadata"
  | "description_sanitized"
  | "description_truncated"
  | "invalid_image_url"
  | "invalid_external_url";
export interface TokenMetadata {
  token: string;
  description?: string;
  imageUrl?: string;
  externalUrl?: string;
}
export interface DecodedTokenMetadata {
  metadata: TokenMetadata | null;
  issues: TokenMetadataIssue[];
}

// These are stored creator claims, never permission to fetch an address. The
// separate image-serving boundary must validate hosts, resolved IPs and bytes.
function metadataUrl(value: string): string | undefined {
  if (!value) return undefined;
  if (
    value.length > tokenMetadataLimits.urlCharacters ||
    /[\u0000-\u0020\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    return undefined;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:", "ipfs:", "ipns:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Decode bounded, untrusted presentation fields only. extraData stays opaque
 * in raw evidence; it cannot assert social identity, verification or ownership. */
export function decodeTokenMetadata(log: RawLog): DecodedTokenMetadata {
  if (
    log.removed ||
    log.address.toLowerCase() !== tokenMetadataFactory ||
    log.topics[0]?.toLowerCase() !== tokenMetadataTopic
  )
    return { metadata: null, issues: ["unsupported_metadata_source"] };
  if (log.data.length > 2 + tokenMetadataLimits.eventBytes * 2)
    return { metadata: null, issues: ["metadata_event_too_large"] };
  try {
    if (log.topics.length !== 1 || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(log.data))
      throw Error("Malformed event");
    const { args } = decodeEventLog({
      abi: [tokenMetadataEvent],
      ...log,
      strict: true,
    });
    // Also reject trailing data, invalid UTF-8 and noncanonical ABI offsets.
    if (
      encodeAbiParameters(tokenMetadataEvent.inputs, [
        args.tokenAddress,
        args.metadata,
      ]).toLowerCase() !== log.data.toLowerCase() ||
      /^0x0{40}$/u.test(args.tokenAddress)
    )
      throw Error("Malformed event");
    const metadata: TokenMetadata = { token: args.tokenAddress.toLowerCase() };
    const issues: TokenMetadataIssue[] = [];
    const description = args.metadata.description.replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
      "",
    );
    if (description !== args.metadata.description)
      issues.push("description_sanitized");
    const characters = Array.from(description);
    if (characters.length > tokenMetadataLimits.descriptionCharacters)
      issues.push("description_truncated");
    if (description)
      metadata.description = characters
        .slice(0, tokenMetadataLimits.descriptionCharacters)
        .join("");
    metadata.imageUrl = metadataUrl(args.metadata.image);
    metadata.externalUrl = metadataUrl(args.metadata.website);
    if (args.metadata.image && !metadata.imageUrl)
      issues.push("invalid_image_url");
    if (args.metadata.website && !metadata.externalUrl)
      issues.push("invalid_external_url");
    // Missing fields remain absent, preserving legacy catalog fixtures and
    // preventing an unavailable field from masquerading as an empty value.
    if (!metadata.imageUrl) delete metadata.imageUrl;
    if (!metadata.externalUrl) delete metadata.externalUrl;
    return { metadata, issues };
  } catch {
    return { metadata: null, issues: ["malformed_metadata"] };
  }
}
