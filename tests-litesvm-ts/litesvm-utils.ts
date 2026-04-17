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
export const readAcct = (acct1: PublicKey, acctOwner: PublicKey) => {
  const pdaRaw = svm.getAccount(acct1);
  expect(pdaRaw).to.not.be.null;
  const rawAccountData = pdaRaw?.data;
  console.log("rawAccountData:", rawAccountData);
  console.log("pdaRaw?.owner:", pdaRaw?.owner.toBase58());
  acctEqual(pdaRaw?.owner, acctOwner);
  return rawAccountData;
};
//-------------== Program Methods
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
    programId: registryAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(svm, blockhash, [ix], [signer], registryAddr);
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
  svm: LiteSVM,
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
