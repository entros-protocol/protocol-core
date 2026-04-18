import { AccountLayout } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  ComputeBudget,
  type FailedTransactionMetadata,
  LiteSVM,
  type SimulatedTransactionInfo,
  TransactionMetadata,
} from "litesvm";
import { numToBytes } from "./encodeDecode.ts";

export let svm = new LiteSVM();
export const zero = BigInt(0);
export const ownerKp = new Keypair();
export const adminKp = new Keypair();
export const user1Kp = new Keypair();

export const owner = ownerKp.publicKey;
export const admin = adminKp.publicKey;
export const user1 = user1Kp.publicKey;

export const initSolBalc = BigInt(LAMPORTS_PER_SOL) * BigInt(10);
console.log("initialize accounts by airdropping SOLs");

svm.airdrop(owner, initSolBalc);
svm.airdrop(admin, initSolBalc);
svm.airdrop(user1, initSolBalc);

export const iamAnchorAddr = new PublicKey(
  "GZYwTp2ozeuRA5Gof9vs4ya961aANcJBdUzB7LN6q4b2",
);
console.log("iamAnchorAddr:", iamAnchorAddr.toBase58());

export const registryAddr = new PublicKey(
  "6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW",
);
console.log("registryAddr:", registryAddr.toBase58());

export const verifierAddr = new PublicKey(
  "4F97jNoxQzT2qRbkWpW3ztC3Nz2TtKj3rnKG8ExgnrfV",
);
console.log("verifierAddr:", verifierAddr.toBase58());

export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111"); //default or anchor.web3.SystemProgram.programId

//-------------==
export const acctIsNull = (account: PublicKey) => {
  const raw = svm.getAccount(account);
  expect(raw).to.be.null;
};
export const acctExists = (account: PublicKey) => {
  const raw = svm.getAccount(account);
  expect(raw).to.not.be.null;
};
export const acctEqual = (acct1: PublicKey | undefined, acct2: PublicKey) => {
  if (!acct1) {
    expect.fail("acct1 is undefined");
  }
  expect(acct1.toBase58()).equal(acct2.toBase58());
};
export const readAcct = (acct1: PublicKey, acctOwner?: PublicKey) => {
  const pdaRaw = svm.getAccount(acct1);
  expect(pdaRaw).to.not.be.null;
  const rawAccountData = pdaRaw?.data;
  console.log("rawAccountData:", rawAccountData);
  console.log("pdaRaw?.owner:", pdaRaw?.owner.toBase58());
  if (acctOwner) acctEqual(pdaRaw?.owner, acctOwner);
  return rawAccountData;
};
export const ataBalc = (
  ata: PublicKey,
  name = "token balc",
  isVerbose = true,
) => {
  const raw = svm.getAccount(ata);
  if (!raw) {
    if (isVerbose) console.log(name, ": ata is null");
    return zero;
  }
  const rawAcctData = raw?.data;
  const decoded = AccountLayout.decode(rawAcctData);
  if (isVerbose) console.log(name, ":", decoded.amount);
  return decoded.amount;
};
export const ataBalCk = (
  ata: PublicKey,
  expectedAmount: bigint,
  name: string,
  decimals = 6,
) => {
  const amount = ataBalc(ata, name, false);
  console.log(name, "token:", amount, amount / BigInt(10 ** decimals));
  expect(amount).eq(expectedAmount);
};
//-------------== iamRegistry Program Methods
export const initializeProtocol = (
  signer: Keypair,
  protocol_config: PublicKey,
  min_stake: bigint,
  challenge_expiry: bigint, //i64,
  max_trust_score: number, //u16,
  base_trust_increment: number, //u16,
  verification_fee: bigint,
) => {
  const disc = [188, 233, 252, 106, 134, 146, 202, 91]; //copied from Anchor IDL
  const progAddr = registryAddr;
  if (challenge_expiry < 0) {
    throw new Error("challenge_expiry should be positive");
  }
  const argData = [
    ...numToBytes(min_stake),
    ...numToBytes(challenge_expiry),
    ...numToBytes(max_trust_score, 16),
    ...numToBytes(base_trust_increment, 16),
    ...numToBytes(verification_fee),
  ];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: protocol_config, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr);
};
//-------------== iamAnchor Program Methods
export const mintAnchor = (
  signer: Keypair,
  commitment: Buffer<ArrayBuffer>,
  identity_state: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  tokenAccount: PublicKey,
  associatedTokenProgram: PublicKey,
  tokenProgram: PublicKey,
  //systemProgram: PublicKey,
  protocol_config: PublicKey,
  treasury: PublicKey,
) => {
  const disc = [68, 56, 113, 102, 236, 152, 146, 60]; //copied from Anchor IDL
  const progAddr = iamAnchorAddr;
  const argData = [...commitment];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: identity_state, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: mintAuthority, isSigner: false, isWritable: false }, //non writable
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: associatedTokenProgram, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: protocol_config, isSigner: false, isWritable: false }, //belongs to registry
      { pubkey: treasury, isSigner: false, isWritable: true },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr);
};

export const updateAnchor = (
  signer: Keypair,
  new_commitment: Buffer<ArrayBuffer>,
  identity_state: PublicKey,
  protocol_config: PublicKey,
  treasury: PublicKey,
  //systemProgram: PublicKey,
) => {
  const disc = [120, 192, 72, 245, 112, 246, 119, 135]; //copied from Anchor IDL
  const progAddr = iamAnchorAddr;
  const argData = [...new_commitment];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: identity_state, isSigner: false, isWritable: true },
      { pubkey: protocol_config, isSigner: false, isWritable: false }, //belongs to registry
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr);
};

export const createChallenge = (
  signer: Keypair, //challenger
  nonce: number[],
  challengePda: PublicKey,
  //systemProgram: PublicKey,
) => {
  const disc = [170, 244, 47, 1, 1, 15, 173, 239]; //copied from Anchor IDL
  const progAddr = verifierAddr;
  const argData = [...nonce];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: challengePda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr);
};

//-------------== Time Manipulation
export const getJsTime = () => {
  const time = Math.floor(Date.now() / 1000);
  console.log("JS time:", time);
  return time;
};
export const setTime = (time: bigint) => {
  const clock = svm.getClock();
  clock.unixTimestamp = time;
  svm.setClock(clock);
};
export const day = 86400; // seconds
export const warpTime = (seconds: number) => {
  const clock = svm.getClock();
  clock.unixTimestamp += BigInt(seconds);
  svm.setClock(clock);
};
//-------------== Deployment
export const deployProgram = (
  programPath: string,
  programId: PublicKey,
  computeMaxUnits?: bigint,
) => {
  if (computeMaxUnits) {
    const computeBudget = new ComputeBudget();
    computeBudget.computeUnitLimit = computeMaxUnits;
    svm = svm.withComputeBudget(computeBudget);
  }
  //# Dump a program from mainnet
  //solana program dump progAddr pyth.so --url mainnet-beta
  svm.addProgramFromFile(programId, programPath);
};
deployProgram("target/deploy/iam_anchor.so", iamAnchorAddr);
acctExists(iamAnchorAddr);
deployProgram("target/deploy/iam_registry.so", registryAddr);
acctExists(registryAddr);
deployProgram("target/deploy/iam_verifier.so", verifierAddr);
acctExists(verifierAddr);
console.log("program deployment is successful");

//-------------== Send Transactions
export const sendTxns = (
  blockhash: string,
  ixs: TransactionInstruction[],
  signerKps: Keypair[],
  programId: PublicKey,
  expectedError = "",
) => {
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.add(...ixs);
  tx.sign(...signerKps); //first signature is considered "primary" and is used identify and confirm transactions.
  const simRes = svm.simulateTransaction(tx);
  const sendRes = svm.sendTransaction(tx);
  checkLogs(simRes, sendRes, programId, expectedError);
};
export const checkLogs = (
  simRes: FailedTransactionMetadata | SimulatedTransactionInfo,
  sendRes: TransactionMetadata | FailedTransactionMetadata,
  programId: PublicKey,
  expectedError = "",
  isVerbose = false,
) => {
  console.log("\nsimRes meta prettylogs:", simRes.meta().prettyLogs());
  /** simRes.meta():
      computeUnitsConsumed: [class computeUnitsConsumed],
      innerInstructions: [class innerInstructions],
      logs: [class logs],
      prettyLogs: [class prettyLogs],
      returnData: [class returnData],
      signature: [class signature],
      toString: [class toString], */
  if (sendRes instanceof TransactionMetadata) {
    const simResMetalogs = simRes.meta().logs();
    if (isVerbose) {
      console.log("txn succeeded 1");
      console.log(
        "simRes.meta().logs():",
        simResMetalogs.length,
        simResMetalogs,
      );
      const sendReslogs = sendRes.logs();
      console.log("sendRes.logs():", sendReslogs.length, sendReslogs);
      //expect(simRes.meta().logs()).eq(sendRes.logs());
      console.log("txn succeeded 2");
    }
    //console.log("sendRes.logs()[logIndex]:", sendRes.logs()[logIndex]);
    expect(sendRes.logs()[simResMetalogs.length - 1]).eq(
      `Program ${programId} success`,
    );
  } else {
    console.log("txn failed");
    console.log("sendRes.err():", sendRes.err());
    console.log("sendRes.meta():", sendRes.meta());
    const errStr = sendRes.toString();
    console.log("sendRes.toString():", errStr);
    const pos = errStr.search("custom program error: 0x");
    console.log("pos:", pos);
    if (pos > -1) {
      let errCode = errStr.substring(pos + 22, pos + 26);
      if (errCode.slice(-1) === '"') {
        //console.log("last char:", errCode.slice(-1));
        errCode = errCode.slice(0, -1);
      }
      console.log("error code:", errCode, Number(errCode));
    }
    console.log(
      "find error here: https://docs.rs/solana-sdk/latest/solana_sdk/transaction/enum.TransactionError.html",
    );
    if (expectedError) {
      const foundErrorMesg = sendRes
        .toString()
        .includes(`custom program error: ${expectedError}`);
      console.log("found error?:", foundErrorMesg);
      expect(foundErrorMesg).eq(true);
    } else {
      throw new Error("This error is unexpected");
    }
  }
};
