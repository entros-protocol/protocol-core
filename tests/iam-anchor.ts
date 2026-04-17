import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import type { IamAnchor } from "../target/types/iam_anchor";
import type { IamRegistry } from "../target/types/iam_registry";
import type { IamVerifier } from "../target/types/iam_verifier";
import {
  deriveChallengePda,
  deriveIdentityPda,
  deriveMintPda,
  deriveVerificationPda,
  generateNonce,
  loadProofFixture,
} from "./utils";

describe("iam-anchor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.iamAnchor as Program<IamAnchor>;
  const registry = anchor.workspace.iamRegistry as Program<IamRegistry>;
  const iamAnchorProgId = program.programId;

  const iamVerifier = anchor.workspace.iamVerifier as Program<IamVerifier>;
  const iamVerifierProgId = iamVerifier.programId;
  let trustScore1vrf: number;
  let trustScore2vrf: number;

  const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    iamAnchorProgId,
  );

  const [protocolConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    registry.programId,
  );

  const [treasuryPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_treasury")],
    registry.programId,
  );

  const commitment = Buffer.alloc(32);
  commitment.write("initial_commitment_test", "utf-8");

  before(async () => {
    // Initialize protocol config (needed for update_anchor trust score computation).
    // Runs before iam-registry tests alphabetically, so we initialize it here.
    try {
      await registry.methods
        .initializeProtocol(
          new anchor.BN(1_000_000_000),
          new anchor.BN(300),
          10000,
          100,
          new anchor.BN(0),
        )
        .accountsStrict({
          admin: provider.wallet.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch {
      // Already initialized from a previous run
    }
  });

  it("mints an identity anchor", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, iamAnchorProgId);
    const [mintPda] = deriveMintPda(user.publicKey, iamAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .mintAnchor(Array.from(commitment))
      .accountsStrict({
        user: user.publicKey,
        identityState: identityPda,
        mint: mintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ata,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
      })
      .rpc();

    // Verify IdentityState
    const identity = await program.account.identityState.fetch(identityPda);
    expect(identity.owner.toBase58()).to.equal(user.publicKey.toBase58());
    expect(identity.verificationCount).to.equal(0);
    expect(identity.trustScore).to.equal(0);
    expect(Buffer.from(identity.currentCommitment)).to.deep.equal(commitment);
    expect(identity.mint.toBase58()).to.equal(mintPda.toBase58());

    // Verify token balance
    const tokenAccount = await getAccount(
      provider.connection,
      ata,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(Number(tokenAccount.amount)).to.equal(1);
  });

  it("fails to mint duplicate identity", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, iamAnchorProgId);
    const [mintPda] = deriveMintPda(user.publicKey, iamAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    try {
      await program.methods
        .mintAnchor(Array.from(commitment))
        .accountsStrict({
          user: user.publicKey,
          identityState: identityPda,
          mint: mintPda,
          mintAuthority: mintAuthorityPda,
          tokenAccount: ata,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("allows different users to mint their own identity", async () => {
    const user2 = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      user2.publicKey,
      5_000_000_000,
    );
    await provider.connection.confirmTransaction(sig);

    const [identityPda] = deriveIdentityPda(user2.publicKey, iamAnchorProgId);
    const [mintPda] = deriveMintPda(user2.publicKey, iamAnchorProgId);
    const ata = getAssociatedTokenAddressSync(
      mintPda,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .mintAnchor(Array.from(commitment))
      .accountsStrict({
        user: user2.publicKey,
        identityState: identityPda,
        mint: mintPda,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ata,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
      })
      .signers([user2])
      .rpc();

    const identity = await program.account.identityState.fetch(identityPda);
    expect(identity.owner.toBase58()).to.equal(user2.publicKey.toBase58());
  });

  it("updates identity state with auto-computed trust score", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, iamAnchorProgId);

    const newCommitment = Buffer.alloc(32);
    newCommitment.write("updated_commitment_v2!", "utf-8");

    await program.methods
      .updateAnchor(Array.from(newCommitment))
      .accountsStrict({
        authority: user.publicKey,
        identityState: identityPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const identity = await program.account.identityState.fetch(identityPda);
    expect(identity.verificationCount).to.equal(1);
    // Trust score is auto-computed: brand-new identity with 1 verification
    // recency_score = 3000/30 = 100, base = (100/100)*100 = 100, age ~0 days
    console.log("1 verif trustScore:", identity.trustScore);
    expect(identity.trustScore).to.be.greaterThanOrEqual(100);
    expect(Buffer.from(identity.currentCommitment)).to.deep.equal(
      newCommitment,
    );
    trustScore1vrf = identity.trustScore;
  });

  it("rejects update from unauthorized wallet", async () => {
    const attacker = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2_000_000_000,
    );
    await provider.connection.confirmTransaction(sig);

    // Target the real user's identity PDA
    const [identityPda] = deriveIdentityPda(
      provider.wallet.publicKey,
      iamAnchorProgId,
    );

    const fakeCommitment = Buffer.alloc(32);
    fakeCommitment.write("attacker_commitment!", "utf-8");

    try {
      await program.methods
        .updateAnchor(Array.from(fakeCommitment))
        .accountsStrict({
          authority: attacker.publicKey,
          identityState: identityPda,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
          treasury: treasuryPda,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — unauthorized update");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("charges verification fee on update_anchor", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, iamAnchorProgId);

    // Set verification fee to 5_000_000 lamports (0.005 SOL)
    await registry.methods
      .updateProtocolConfig(new anchor.BN(5_000_000))
      .accountsStrict({
        admin: user.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const treasuryBefore = await provider.connection.getBalance(treasuryPda);

    const feeCommitment = Buffer.alloc(32);
    feeCommitment.write("fee_test_commitment!!!!!", "utf-8");

    await program.methods
      .updateAnchor(Array.from(feeCommitment))
      .accountsStrict({
        authority: user.publicKey,
        identityState: identityPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const treasuryAfter = await provider.connection.getBalance(treasuryPda);
    expect(treasuryAfter).to.equal(treasuryBefore + 5_000_000);

    // Reset fee to 0
    await registry.methods
      .updateProtocolConfig(new anchor.BN(0))
      .accountsStrict({
        admin: user.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("rejects transfer of non-transferable token", async () => {
    const user = provider.wallet;
    const [mintPda] = deriveMintPda(user.publicKey, iamAnchorProgId);
    const sourceAta = getAssociatedTokenAddressSync(
      mintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const recipient = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      recipient.publicKey,
      1_000_000_000,
    );
    await provider.connection.confirmTransaction(sig);

    const destAta = getAssociatedTokenAddressSync(
      mintPda,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    try {
      await transfer(
        provider.connection,
        (provider.wallet as any).payer,
        sourceAta,
        destAta,
        user.publicKey,
        1,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      expect.fail("Transfer should have been rejected");
    } catch (err: any) {
      // Token-2022 NonTransferable extension rejects transfers
      expect(err).to.exist;
    }
  });

  it("trust score should not change after multiple verifications on the same-day", async () => {
    const user = provider.wallet;
    const [identityPda] = deriveIdentityPda(user.publicKey, iamAnchorProgId);

    let identity = await program.account.identityState.fetch(identityPda);
    expect(identity.verificationCount).to.equal(2);
    trustScore2vrf = identity.trustScore;
    console.log("2 verif trustScore:", trustScore2vrf);
    expect(trustScore2vrf).to.equal(trustScore1vrf);

    //-----------== iamVerifier
    const nonce = generateNonce();
    const [challengePda] = deriveChallengePda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );
    const [verificationPda] = deriveVerificationPda(
      provider.wallet.publicKey,
      nonce,
      iamVerifierProgId,
    );

    await iamVerifier.methods
      .createChallenge(nonce)
      .accountsStrict({
        challenger: provider.wallet.publicKey,
        challenge: challengePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const fixture = loadProofFixture();
    const proofBytes = Buffer.from(fixture.proof_bytes);
    const publicInputs: number[][] = fixture.public_inputs;

    await iamVerifier.methods
      .verifyProof(proofBytes, publicInputs, nonce)
      .accountsStrict({
        verifier: provider.wallet.publicKey,
        challenge: challengePda,
        verificationResult: verificationPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    //-----------== iamAnchor: updates identity state with auto-computed trust score
    const newCommitment = Buffer.alloc(32);
    newCommitment.write("dedup_trust_score_test!!!", "utf-8");

    await program.methods
      .updateAnchor(Array.from(newCommitment))
      .accountsStrict({
        authority: user.publicKey,
        identityState: identityPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    identity = await program.account.identityState.fetch(identityPda);
    expect(identity.verificationCount).to.equal(3);
    console.log("3 verif trustScore:", identity.trustScore);
    expect(identity.trustScore).to.equal(trustScore2vrf);
  });
});
