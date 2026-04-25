import { AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
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
import {
  getPdas,
  entrosAnchorAddr,
  loadProofFixture,
  numToBytes,
  registryAddr,
  verifierAddr,
} from "./encodeDecode.ts";

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

export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111"); //default or anchor.web3.SystemProgram.programId
export const pdasAdmin = getPdas(admin);
export const pdasUser1 = getPdas(user1);
export const pdasBySignerKp = (signerKp: Keypair) => {
  switch (signerKp.publicKey.toBase58()) {
    case admin.toBase58():
      return pdasAdmin;
    case user1.toBase58():
      return pdasUser1;
    default: {
      throw new Error("invalid signer");
    }
  }
};

export const verifyUser = (signerKp: Keypair) => {
  const { signer, identityPda, mintPda, nonce, challengePda, verificationPda } =
    pdasBySignerKp(signerKp);

  createChallenge(signerKp, nonce, challengePda);

  const fixture = loadProofFixture();

  const proofBytes: Buffer<ArrayBuffer> = Buffer.from(fixture.proof_bytes); // for Rust Vec<u8>
  const publicInputs: number[][] = fixture.public_inputs; // for Rust Vec<[u8; 32]>
  verifyProof(
    signerKp,
    proofBytes,
    publicInputs,
    nonce,
    challengePda,
    verificationPda,
  );
  return {
    signer,
    identityPda,
    mintPda,
    nonce,
    challengePda,
    verificationPda,
    fixture,
  };
};
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
//-------------== entrosRegistry Program Methods
export const initializeProtocol = (
  signer: Keypair,
  protocol_config: PublicKey,
  min_stake: bigint,
  challenge_expiry: bigint, //i64,
  max_trust_score: number, //u16,
  base_trust_increment: number, //u16,
  verification_fee: bigint,
  expectedErr = "",
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
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};

export const updateProtocolConfig = (
  signer: Keypair, //admin
  verification_fee: bigint,
  protocol_config: PublicKey,
  expectedErr = "",
) => {
  const disc = [197, 97, 123, 54, 221, 168, 11, 135]; //copied from Anchor IDL
  const progAddr = registryAddr;

  const argData = [...numToBytes(verification_fee)];
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
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};

export const registerValidator = (
  signer: Keypair, //admin
  min_stake: bigint,
  protocol_config: PublicKey,
  validator_state: PublicKey,
  vault: PublicKey,
  expectedErr = "",
) => {
  const disc = [118, 98, 251, 58, 81, 30, 13, 240]; //copied from Anchor IDL
  const progAddr = registryAddr;

  const argData = [...numToBytes(min_stake)];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: protocol_config, isSigner: false, isWritable: true },
      { pubkey: validator_state, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};
//-------------== entrosAnchor Program Methods
export const mintAnchor = (
  signer: Keypair,
  commitment: Buffer<ArrayBuffer>,
  identity_state: PublicKey,
  mint: PublicKey,
  mintAuthority: PublicKey,
  tokenAccount: PublicKey,
  associatedTokenProgram = ASSOCIATED_TOKEN_PROGRAM_ID,
  tokenProgram: PublicKey,
  protocol_config: PublicKey,
  treasury: PublicKey,
  expectedErr = "",
) => {
  const disc = [68, 56, 113, 102, 236, 152, 146, 60]; //copied from Anchor IDL
  const progAddr = entrosAnchorAddr;
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
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};

export const updateAnchor = (
  signer: Keypair,
  new_commitment: Buffer<ArrayBuffer>,
  verification_nonce: number[],
  verification_result: PublicKey,
  identity_state: PublicKey,
  protocol_config: PublicKey,
  treasury: PublicKey,
  expectedErr = "",
) => {
  const disc = [120, 192, 72, 245, 112, 246, 119, 135]; //copied from Anchor IDL
  const progAddr = entrosAnchorAddr;
  const new_commitment_array = Array.from(new_commitment);
  console.log("new_commitment_array:", new_commitment_array);
  const argData = [...new_commitment_array, ...verification_nonce];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: identity_state, isSigner: false, isWritable: true },
      { pubkey: verification_result, isSigner: false, isWritable: true },
      { pubkey: protocol_config, isSigner: false, isWritable: false }, //belongs to registry
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};

export const resetIdentityState = (
  signer: Keypair,
  new_commitment: Buffer<ArrayBuffer>,
  identity_state: PublicKey,
  protocol_config: PublicKey,
  treasury: PublicKey,
  expectedErr = "",
) => {
  const disc = [26, 78, 86, 143, 247, 132, 85, 203]; //copied from Anchor IDL
  const progAddr = entrosAnchorAddr;
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
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};

export const createChallenge = (
  signer: Keypair, //challenger
  nonce: number[],
  challengePda: PublicKey,
  expectedErr = "",
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
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
};

export const verifyProof = (
  signer: Keypair, //challenger
  proofBytes: Buffer<ArrayBuffer>, // Vec<u8>
  publicInputs: number[][], // Vec<[u8; 32]>
  nonce: number[], // [u8; 32]
  challengePda: PublicKey,
  verificationPda: PublicKey,
  expectedErr = "",
) => {
  const disc = [217, 211, 191, 110, 144, 13, 186, 98]; //copied from Anchor IDL
  const progAddr = verifierAddr;
  const proofLen = Buffer.alloc(4);
  proofLen.writeUInt32LE(proofBytes.length, 0);
  const publicInputsLen = Buffer.alloc(4);
  publicInputsLen.writeUInt32LE(publicInputs.length, 0);
  const argData = [
    ...proofLen,
    ...proofBytes,
    ...publicInputsLen,
    ...publicInputs.flat(1),
    ...nonce,
  ];
  const blockhash = svm.latestBlockhash();
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: challengePda, isSigner: false, isWritable: true },
      { pubkey: verificationPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    programId: progAddr,
    data: Buffer.from([...disc, ...argData]),
  });
  sendTxns(blockhash, [ix], [signer], progAddr, expectedErr);
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
export const warpSlot = (newSlot: number) => {
  svm.warpToSlot(BigInt(newSlot));
  const slot1 = svm.getClock().slot;
  console.log("new slot:", slot1);
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
deployProgram("target/deploy/entros_anchor.so", entrosAnchorAddr);
acctExists(entrosAnchorAddr);
deployProgram("target/deploy/entros_registry.so", registryAddr);
acctExists(registryAddr);
deployProgram("target/deploy/entros_verifier.so", verifierAddr);
acctExists(verifierAddr);
console.log("program deployment is successful");

//-------------== Send Transactions
export const expireBlockhash = () => svm.expireBlockhash();

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
//-------------== Send SOL
export const sendSol = (
  signer: Keypair,
  receiver: PublicKey,
  transferLamports = BigInt(1_000_000),
  expectedError = "",
) => {
  //const receiver = PublicKey.unique();
  const blockhash = svm.latestBlockhash();
  const ixs = [
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: receiver,
      lamports: transferLamports,
    }),
  ];
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.add(...ixs);
  tx.sign(signer);
  const simRes = svm.simulateTransaction(tx);
  const sendRes = svm.sendTransaction(tx);
  checkLogs(simRes, sendRes, SYSTEM_PROGRAM, expectedError);
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
    let errCode = "";
    if (pos > -1) {
      errCode = errStr.substring(pos + 22, pos + 28);
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
      const foundErrorMesg = sendRes.toString().includes(`${expectedError}`);
      console.log("found error?:", foundErrorMesg);
      expect(foundErrorMesg).eq(true);
    } else {
      const pos1 = errStr.search("Program log");
      console.log("pos1:", pos1);
      const pos2 = errStr.search("consumed");
      console.log("pos2:", pos2);
      let err_mesg = "";
      if (pos1 > -1 && pos2 > -1) {
        err_mesg = errStr.substring(pos1, pos2);
        //console.log("err_mesg:", err_mesg);
      }
      throw new Error(
        `Unexpected error: ${err_mesg}  errCode: ${errCode}, ${Number(errCode)}`,
      );
    }
  }
};
