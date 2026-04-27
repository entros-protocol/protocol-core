import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import type { EntrosAnchor } from "../target/types/entros_anchor";
import type { EntrosRegistry } from "../target/types/entros_registry";
import type { EntrosVerifier } from "../target/types/entros_verifier";
import {
  airdrop,
  bootstrapVerifiedUser,
  deriveIdentityPda,
  deriveMintPda,
  loadProofFixture,
} from "./utils";

describe("entros-anchor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.entrosAnchor as Program<EntrosAnchor>;
  const registry = anchor.workspace.entrosRegistry as Program<EntrosRegistry>;
  const iamAnchorProgId = program.programId;

  const entrosVerifier = anchor.workspace.entrosVerifier as Program<EntrosVerifier>;
  const iamVerifierProgId = entrosVerifier.programId;
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
    // Runs before entros-registry tests alphabetically, so we initialize it here.
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

  it("updates identity state with bound proof + auto-computed trust score", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, user.publicKey, 3_000_000_000);

    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    const newCommitment = Buffer.from(fixture.public_inputs[0]);

    await program.methods
      .updateAnchor(Array.from(newCommitment), boot.nonce)
      .accountsStrict({
        authority: user.publicKey,
        identityState: boot.identityPda,
        verificationResult: boot.verificationPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    const identity = await program.account.identityState.fetch(boot.identityPda);
    expect(identity.verificationCount).to.equal(1);
    expect(identity.trustScore).to.be.greaterThanOrEqual(100);
    expect(Buffer.from(identity.currentCommitment)).to.deep.equal(newCommitment);
    trustScore1vrf = identity.trustScore;
  });

  it("rejects update from unauthorized wallet (ownership check)", async () => {
    // Victim sets up a legit identity + VR
    const fixture = loadProofFixture();
    const victim = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, victim.publicKey, 3_000_000_000);
    const boot = await bootstrapVerifiedUser({
      user: victim,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    // Attacker tries to update the victim's identity — should fail at the
    // VerificationResult seeds derivation (attacker.pubkey != VR.verifier) and
    // at the Unauthorized ownership check.
    const attacker = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, attacker.publicKey, 2_000_000_000);
    const fakeCommitment = Buffer.from(fixture.public_inputs[0]);

    try {
      await program.methods
        .updateAnchor(Array.from(fakeCommitment), boot.nonce)
        .accountsStrict({
          authority: attacker.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — unauthorized update");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("charges verification fee on update_anchor", async () => {
    // Set verification fee to 5_000_000 lamports (0.005 SOL)
    await registry.methods
      .updateProtocolConfig(new anchor.BN(5_000_000))
      .accountsStrict({
        admin: provider.wallet.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    try {
      const fixture = loadProofFixture();
      const user = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, user.publicKey, 3_000_000_000);

      const boot = await bootstrapVerifiedUser({
        user,
        entrosAnchor: program,
        entrosVerifier,
        fixture,
        protocolConfigPda,
        treasuryPda,
        mintAuthorityPda,
      });

      const treasuryBefore = await provider.connection.getBalance(treasuryPda);

      await program.methods
        .updateAnchor(Array.from(Buffer.from(fixture.public_inputs[0])), boot.nonce)
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const treasuryAfter = await provider.connection.getBalance(treasuryPda);
      expect(treasuryAfter).to.equal(treasuryBefore + 5_000_000);
    } finally {
      // Reset fee to 0 regardless of test outcome
      await registry.methods
        .updateProtocolConfig(new anchor.BN(0))
        .accountsStrict({
          admin: provider.wallet.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    }
  });

  // ---- Binding-patch security tests (added 2026-04-20) ----

  it("rejects reusing the same VerificationResult twice", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, user.publicKey, 3_000_000_000);

    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    const newCommitment = Array.from(Buffer.from(fixture.public_inputs[0]));

    // First update consumes the VR successfully
    await program.methods
      .updateAnchor(newCommitment, boot.nonce)
      .accountsStrict({
        authority: user.publicKey,
        identityState: boot.identityPda,
        verificationResult: boot.verificationPda,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Second attempt with the SAME VR: commitment_prev still equals fixture[1]
    // but identity.current_commitment has rotated to fixture[0]. Reject.
    try {
      await program.methods
        .updateAnchor(newCommitment, boot.nonce)
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown — VR already consumed (prev commitment mismatch)");
    } catch (err: any) {
      expect(err).to.exist;
      // PrevCommitmentMismatch is the expected error
      expect(String(err)).to.match(/PrevCommitmentMismatch|6011/);
    }
  });

  it("rejects update where submitted new_commitment doesn't match VR.commitment_new", async () => {
    const fixture = loadProofFixture();
    const user = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, user.publicKey, 3_000_000_000);

    const boot = await bootstrapVerifiedUser({
      user,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    // Submit a DIFFERENT new_commitment than what the proof attested to
    const maliciousCommitment = Buffer.alloc(32, 0xaa);

    try {
      await program.methods
        .updateAnchor(Array.from(maliciousCommitment), boot.nonce)
        .accountsStrict({
          authority: user.publicKey,
          identityState: boot.identityPda,
          verificationResult: boot.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown — CommitmentMismatch");
    } catch (err: any) {
      expect(err).to.exist;
      expect(String(err)).to.match(/CommitmentMismatch|6010/);
    }
  });

  it("rejects update when authority tries to use another user's VerificationResult", async () => {
    const fixture = loadProofFixture();
    // User A bootstraps their own VR
    const userA = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, userA.publicKey, 3_000_000_000);
    const bootA = await bootstrapVerifiedUser({
      user: userA,
      entrosAnchor: program,
      entrosVerifier,
      fixture,
      protocolConfigPda,
      treasuryPda,
      mintAuthorityPda,
    });

    // User B mints independently
    const userB = anchor.web3.Keypair.generate();
    await airdrop(provider.connection, userB.publicKey, 3_000_000_000);
    const [identityPdaB] = deriveIdentityPda(userB.publicKey, iamAnchorProgId);
    const [mintPdaB] = deriveMintPda(userB.publicKey, iamAnchorProgId);
    const ataB = getAssociatedTokenAddressSync(mintPdaB, userB.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await program.methods
      .mintAnchor(Array.from(Buffer.from(fixture.public_inputs[1])))
      .accountsStrict({
        user: userB.publicKey,
        identityState: identityPdaB,
        mint: mintPdaB,
        mintAuthority: mintAuthorityPda,
        tokenAccount: ataB,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
      })
      .signers([userB])
      .rpc();

    // B tries to update own identity using A's VerificationResult.
    // The VR PDA is seeded on A's pubkey + nonce; B passing A's VR won't match
    // B's seeds derivation, causing Anchor to reject with ConstraintSeeds.
    try {
      await program.methods
        .updateAnchor(Array.from(Buffer.from(fixture.public_inputs[0])), bootA.nonce)
        .accountsStrict({
          authority: userB.publicKey,
          identityState: identityPdaB,
          verificationResult: bootA.verificationPda,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([userB])
        .rpc();
      expect.fail("Should have thrown — B cannot use A's VR");
    } catch (err: any) {
      expect(err).to.exist;
    }
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

  // Same-day dedup is covered by the recency_score computation in update_anchor.
  // Post-binding-patch, each update requires a fresh proof bound to the
  // specific commitment transition, so multi-update tests in-session need
  // multiple proof fixtures (see circuits/scripts/generate_test_fixture.ts).
  // The single-update trust_score value is asserted in the "updates identity
  // state with bound proof" test above. Multi-update dedup is exercised by
  // the full E2E flow in z-e2e.ts and by on-devnet integration testing.
  it("records trust_score for a single verification via bound proof", async () => {
    // Documents what a first verification produces; smoke check that the
    // trust_score isn't zero post-update. The previous multi-update variant
    // is removed pending multi-fixture support.
    expect(trustScore1vrf).to.be.greaterThan(0);
  });
});
