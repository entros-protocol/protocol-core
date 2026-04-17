import type {
  Address,
  FixedSizeDecoder,
  ReadonlyUint8Array,
} from "@solana/kit";
import {
  fixDecoderSize,
  getAddressDecoder,
  getBytesDecoder,
  getI64Decoder,
  getLamportsEncoder,
  //getBooleanDecoder,
  //getEnumDecoder,
  getStructDecoder,
  getU8Decoder,
  getU8Encoder,
  getU16Decoder,
  getU16Encoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  lamports,
} from "@solana/kit";
import { PublicKey } from "@solana/web3.js";

//-----------== ProtocolConfigPDA
export type ProtocolConfigAcct = {
  anchorDiscriminator: ReadonlyUint8Array;
  admin: Address;
  min_stake: bigint;
  challenge_expiry: bigint;
  max_trust_score: number;
  base_trust_increment: number;
  bump: number;
  verification_fee: bigint;
}; //padding: bigint[];
export const protocolconfigAcctDecoder: FixedSizeDecoder<ProtocolConfigAcct> =
  getStructDecoder([
    ["anchorDiscriminator", fixDecoderSize(getBytesDecoder(), 8)], //only for accounts made by Anchor
    ["admin", getAddressDecoder()],
    ["min_stake", getU64Decoder()],
    ["challenge_expiry", getI64Decoder()],
    ["max_trust_score", getU16Decoder()],
    ["base_trust_increment", getU16Decoder()],
    ["bump", getU8Decoder()],
    ["verification_fee", getU64Decoder()],
    //["padding", getArrayDecoder(getU64Decoder(), { size: 3 })],
  ]);
export const decodeProtocolConfig = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike>,
  isVerbose = false,
) => {
  const decoded = protocolconfigAcctDecoder.decode(bytes);
  if (isVerbose) {
    console.log("admin:", decoded.admin);
    console.log("min_stake:", decoded.min_stake);
    console.log("challenge_expiry:", decoded.challenge_expiry);
    console.log("max_trust_score:", decoded.max_trust_score);
    console.log("base_trust_increment:", decoded.base_trust_increment);
    console.log("bump:", decoded.bump);
    console.log("verification_fee:", decoded.verification_fee);
  }
  return decoded;
};
// This below is only used for @solana/web3.js as it is outputing PublicKey, not Address
export const decodeProtocolConfigWeb3js = (
  bytes: ReadonlyUint8Array | Uint8Array<ArrayBufferLike> | undefined,
) => {
  if (!bytes) throw new Error("bytes invalid");
  const decoded = decodeProtocolConfig(bytes, true);
  const decodedV1: ProtocolConfigAcctWeb3js = {
    admin: new PublicKey(decoded.admin.toString()),
    min_stake: decoded.min_stake,
    challenge_expiry: decoded.challenge_expiry,
    max_trust_score: decoded.max_trust_score,
    base_trust_increment: decoded.base_trust_increment,
    bump: decoded.bump,
    verification_fee: decoded.verification_fee,
  };
  return decodedV1;
};
export type ProtocolConfigAcctWeb3js = {
  admin: PublicKey;
  min_stake: bigint;
  challenge_expiry: bigint;
  max_trust_score: number;
  base_trust_increment: number;
  bump: number;
  verification_fee: bigint;
};

//-------------==
export const numToBytes = (input: bigint | number, bit = 64) => {
  let amtBigint = BigInt(0);
  if (typeof input === "number") {
    if (input < 0) throw new Error("input < 0");
    amtBigint = BigInt(input);
  } else {
    if (input < BigInt(0)) throw new Error("input < 0");
    amtBigint = input;
  }
  const amtLam = lamports(amtBigint);
  // biome-ignore lint/suspicious/noExplicitAny: <>
  let lamportsEncoder: any;
  if (bit === 64) {
    lamportsEncoder = getLamportsEncoder(getU64Encoder());
  } else if (bit === 32) {
    lamportsEncoder = getLamportsEncoder(getU32Encoder());
  } else if (bit === 16) {
    lamportsEncoder = getLamportsEncoder(getU16Encoder());
  } else if (bit === 8) {
    lamportsEncoder = getLamportsEncoder(getU8Encoder());
  } else {
    throw new Error("bit unknown");
    //lamportsEncoder = getDefaultLamportsEncoder()
  }
  const u8Bytes: Uint8Array = lamportsEncoder.encode(amtLam);
  console.log("u8Bytes", u8Bytes);
  return u8Bytes;
};
