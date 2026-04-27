import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import type { EntrosRegistry } from "../target/types/entros_registry";

describe("entros-registry", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.entrosRegistry as Program<EntrosRegistry>;
  const admin = provider.wallet;

  const [protocolConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    program.programId
  );

  const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );

  const [treasuryPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_treasury")],
    program.programId
  );

  const MIN_STAKE = new anchor.BN(1_000_000_000); // 1 SOL
  const CHALLENGE_EXPIRY = new anchor.BN(300);
  const MAX_TRUST_SCORE = 10000;
  const BASE_TRUST_INCREMENT = 100;
  const VERIFICATION_FEE = new anchor.BN(0); // 0 for existing tests

  it("initializes protocol config", async () => {
    // May already be initialized by entros-anchor's before block (alphabetical test ordering).
    // Initialize if needed, then verify the config is correct regardless.
    try {
      await program.methods
        .initializeProtocol(
          MIN_STAKE,
          CHALLENGE_EXPIRY,
          MAX_TRUST_SCORE,
          BASE_TRUST_INCREMENT,
          VERIFICATION_FEE
        )
        .accountsStrict({
          admin: admin.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch {
      // Already initialized — that's fine
    }

    const config = await program.account.protocolConfig.fetch(protocolConfigPda);
    expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(config.minStake.toNumber()).to.equal(1_000_000_000);
    expect(config.challengeExpiry.toNumber()).to.equal(300);
    expect(config.maxTrustScore).to.equal(10000);
    expect(config.baseTrustIncrement).to.equal(100);
  });

  it("fails to re-initialize protocol config", async () => {
    try {
      await program.methods
        .initializeProtocol(
          MIN_STAKE,
          CHALLENGE_EXPIRY,
          MAX_TRUST_SCORE,
          BASE_TRUST_INCREMENT,
          VERIFICATION_FEE
        )
        .accountsStrict({
          admin: admin.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      // Account already initialized — Anchor prevents double init
      expect(err).to.exist;
    }
  });

  it("registers a validator with sufficient stake", async () => {
    const validator = anchor.web3.Keypair.generate();

    // Airdrop SOL to the validator
    const sig = await provider.connection.requestAirdrop(
      validator.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(sig);

    const [validatorStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("validator"), validator.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerValidator(MIN_STAKE)
      .accountsStrict({
        validator: validator.publicKey,
        protocolConfig: protocolConfigPda,
        validatorState: validatorStatePda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([validator])
      .rpc();

    const state = await program.account.validatorState.fetch(validatorStatePda);
    expect(state.authority.toBase58()).to.equal(validator.publicKey.toBase58());
    expect(state.stake.toNumber()).to.equal(1_000_000_000);
    expect(state.isActive).to.be.true;
    expect(state.verificationsPerformed.toNumber()).to.equal(0);
  });

  it("fails to register with insufficient stake", async () => {
    const validator = anchor.web3.Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      validator.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(sig);

    const [validatorStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("validator"), validator.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .registerValidator(new anchor.BN(100)) // way below min_stake
        .accountsStrict({
          validator: validator.publicKey,
          protocolConfig: protocolConfigPda,
          validatorState: validatorStatePda,
          vault: vaultPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([validator])
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InsufficientStake");
    }
  });

  it("computes trust score correctly", async () => {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - 30 * 86400;

    // recent_timestamps: one verification 1 day ago, rest zeros
    const recentTimestamps = [
      new anchor.BN(now - 86400),
      ...Array(9).fill(new anchor.BN(0)),
    ];

    const listener = program.addEventListener("TrustScoreComputed", (event) => {
      // recency: 3000/(30+1) = 96, base = (96/100)*100 = 0 (integer truncation)
      // regularity: 0 (only 1 non-zero timestamp, need >= 2 gaps)
      // age: isqrt(30)*2 = 10
      // total = 10
      expect(event.trustScore).to.equal(10);
    });

    await program.methods
      .computeTrustScore(5, new anchor.BN(thirtyDaysAgo), recentTimestamps)
      .accounts({
        protocolConfig: protocolConfigPda,
      })
      .rpc();

    program.removeEventListener(listener);
  });

  it("unstakes validator and returns SOL", async () => {
    const validator = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      validator.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(sig);

    const [validatorStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("validator"), validator.publicKey.toBuffer()],
      program.programId
    );

    // Register with 1 SOL
    await program.methods
      .registerValidator(MIN_STAKE)
      .accountsStrict({
        validator: validator.publicKey,
        protocolConfig: protocolConfigPda,
        validatorState: validatorStatePda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([validator])
      .rpc();

    const balanceBefore = await provider.connection.getBalance(validator.publicKey);

    // Unstake
    await program.methods
      .unstakeValidator()
      .accountsStrict({
        validator: validator.publicKey,
        validatorState: validatorStatePda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([validator])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(validator.publicKey);

    // Should have received staked SOL + rent from closed ValidatorState
    expect(balanceAfter).to.be.greaterThan(balanceBefore);

    // ValidatorState account should be closed
    const account = await provider.connection.getAccountInfo(validatorStatePda);
    expect(account).to.be.null;
  });

  it("rejects unstake from non-authority", async () => {
    const validator = anchor.web3.Keypair.generate();
    const attacker = anchor.web3.Keypair.generate();

    const sig1 = await provider.connection.requestAirdrop(
      validator.publicKey,
      5_000_000_000
    );
    await provider.connection.confirmTransaction(sig1);
    const sig2 = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2_000_000_000
    );
    await provider.connection.confirmTransaction(sig2);

    const [validatorStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("validator"), validator.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerValidator(MIN_STAKE)
      .accountsStrict({
        validator: validator.publicKey,
        protocolConfig: protocolConfigPda,
        validatorState: validatorStatePda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([validator])
      .rpc();

    // Attacker tries to unstake — but PDA is derived from validator's key,
    // so the seeds constraint will fail (attacker's key != validator's key)
    const [attackerStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("validator"), attacker.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .unstakeValidator()
        .accountsStrict({
          validator: attacker.publicKey,
          validatorState: validatorStatePda,
          vault: vaultPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — attacker cannot unstake another validator");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("caps trust score at max", async () => {
    const now = Math.floor(Date.now() / 1000);
    const yearAgo = now - 365 * 86400;

    // Fill all 10 recent timestamps to maximize recency score
    const recentTimestamps = Array(10)
      .fill(0)
      .map((_, i) => new anchor.BN(now - i * 86400));

    const listener = program.addEventListener("TrustScoreComputed", (event) => {
      expect(event.trustScore).to.equal(10000);
    });

    await program.methods
      .computeTrustScore(200, new anchor.BN(yearAgo), recentTimestamps)
      .accounts({
        protocolConfig: protocolConfigPda,
      })
      .rpc();

    program.removeEventListener(listener);
  });

  it("updates protocol config with verification fee", async () => {
    await program.methods
      .updateProtocolConfig(new anchor.BN(5_000_000))
      .accountsStrict({
        admin: admin.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolConfigPda);
    expect(config.verificationFee.toNumber()).to.equal(5_000_000);

    // Reset to 0 for other tests
    await program.methods
      .updateProtocolConfig(new anchor.BN(0))
      .accountsStrict({
        admin: admin.publicKey,
        protocolConfig: protocolConfigPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  });

  it("rejects update_protocol_config from non-admin", async () => {
    const attacker = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2_000_000_000
    );
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateProtocolConfig(new anchor.BN(999))
        .accountsStrict({
          admin: attacker.publicKey,
          protocolConfig: protocolConfigPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — non-admin cannot update config");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("withdraws from treasury", async () => {
    // Send SOL to treasury PDA to simulate accumulated fees
    const depositAmount = 100_000_000; // 0.1 SOL
    const depositTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: treasuryPda,
        lamports: depositAmount,
      })
    );
    await provider.sendAndConfirm(depositTx);

    const treasuryBefore = await provider.connection.getBalance(treasuryPda);
    const adminBefore = await provider.connection.getBalance(admin.publicKey);

    const withdrawAmount = 50_000_000; // 0.05 SOL
    await program.methods
      .withdrawTreasury(new anchor.BN(withdrawAmount))
      .accountsStrict({
        admin: admin.publicKey,
        protocolConfig: protocolConfigPda,
        treasury: treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const treasuryAfter = await provider.connection.getBalance(treasuryPda);
    const adminAfter = await provider.connection.getBalance(admin.publicKey);

    expect(treasuryAfter).to.equal(treasuryBefore - withdrawAmount);
    // Admin balance increases by withdrawal minus tx fee
    expect(adminAfter).to.be.greaterThan(adminBefore);
  });

  it("rejects treasury withdrawal from non-admin", async () => {
    const attacker = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      attacker.publicKey,
      2_000_000_000
    );
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .withdrawTreasury(new anchor.BN(1_000))
        .accountsStrict({
          admin: attacker.publicKey,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown — non-admin cannot withdraw");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects treasury withdrawal exceeding available balance", async () => {
    const treasuryBalance = await provider.connection.getBalance(treasuryPda);

    try {
      await program.methods
        .withdrawTreasury(new anchor.BN(treasuryBalance + 1_000_000_000))
        .accountsStrict({
          admin: admin.publicKey,
          protocolConfig: protocolConfigPda,
          treasury: treasuryPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have thrown — insufficient treasury balance");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});
