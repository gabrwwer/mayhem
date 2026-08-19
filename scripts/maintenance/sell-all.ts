
#!/usr/bin/env ts-node
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
} from '@solana/spl-token';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://api.jup.ag/swap/v1';
const PUMP_FUN_API = 'https://pumpportal.fun/api/trade-local';
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const SLIPPAGE_BPS = 1500; // 15% slippage for illiquid tokens

function decryptWallet(filePath: string, password: string): Keypair {
  const payload = fs.readFileSync(filePath);
  const salt = payload.subarray(0, 32);
  const iv = payload.subarray(32, 44);
  const authTag = payload.subarray(44, 60);
  const encrypted = payload.subarray(60);
  const key = crypto.pbkdf2Sync(password, salt, 600_000, 32, 'sha512');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const secretKey = new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  return Keypair.fromSecretKey(secretKey);
}

function isPumpFun(mint: string): boolean {
  return mint.endsWith('pump');
}

async function sellViaPumpFun(
  mint: string,
  amount: number,
  keypair: Keypair,
  connection: Connection,
): Promise<string | null> {
  const resp = await fetch(PUMP_FUN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: keypair.publicKey.toBase58(),
      action: 'sell',
      mint,
      amount,
      denominatedInSol: 'false',
      slippage: Math.max(1, Math.floor(SLIPPAGE_BPS / 100)),
      priorityFee: 0.0001,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.log(`  pump.fun API error: ${resp.status} ${body.slice(0, 200)}`);
    return null;
  }

  const txBytes = Buffer.from(await resp.arrayBuffer());
  const vtx = VersionedTransaction.deserialize(txBytes);
  vtx.sign([keypair]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });
  return sig;
}

async function sellViaJupiter(
  mint: string,
  amount: number,
  keypair: Keypair,
  connection: Connection,
): Promise<string | null> {
  const params = new URLSearchParams({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: Math.floor(amount).toString(),
    slippageBps: SLIPPAGE_BPS.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'true',
  });

  const quoteResp = await fetch(`${JUPITER_API}/quote?${params}`);
  if (!quoteResp.ok) {
    const body = await quoteResp.text();
    console.log(`  Jupiter quote error: ${quoteResp.status} ${body.slice(0, 200)}`);
    return null;
  }

  const quoteData = await quoteResp.json() as { outAmount: string };
  const outAmount = parseInt(quoteData.outAmount, 10);
  console.log(`  Jupiter quote: ${amount} tokens â†’ ${(outAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  const swapResp = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      asLegacyTransaction: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });

  if (!swapResp.ok) {
    const body = await swapResp.text();
    console.log(`  Jupiter swap error: ${swapResp.status} ${body.slice(0, 200)}`);
    return null;
  }

  const swapData = await swapResp.json() as { swapTransaction: string };
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = Transaction.from(txBuf);
  tx.partialSign(keypair);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 2,
  });
  return sig;
}

async function closeEmptyAccounts(
  keypair: Keypair,
  connection: Connection,
  accounts: { pubkey: PublicKey; programId: PublicKey }[],
): Promise<number> {
  let closed = 0;
  for (const acc of accounts) {
    try {
      const ix = createCloseAccountInstruction(
        acc.pubkey,
        keypair.publicKey,
        keypair.publicKey,
        [],
        acc.programId,
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = keypair.publicKey;
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(keypair);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      console.log(`  Closed ${acc.pubkey.toBase58().slice(0, 12)}... tx: ${sig.slice(0, 20)}...`);
      closed++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  Failed to close ${acc.pubkey.toBase58().slice(0, 12)}...: ${err}`);
    }
  }
  return closed;
}

async function main() {
  // Walk up to find .env
  let envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    envPath = path.resolve(process.cwd(), '.env');
  }
  console.log('Loading .env from:', envPath);
  const envContent = fs.readFileSync(envPath, 'utf-8').replace(/^ï»¿/, '');
  const env: Record<string, string> = {};
  for (const line of envContent.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }

  const rpcUrl = env['SOLANA_RPC_URL'];
  const walletPath = env['WALLET_FILE_PATH'] || path.join(require('os').homedir(), '.mayhem', 'wallet.enc');
  const walletPassword = env['WALLET_PASSWORD'];

  if (!rpcUrl || !walletPassword) {
    console.error('Missing SOLANA_RPC_URL or WALLET_PASSWORD in .env');
    process.exit(1);
  }

  console.log('=== MAYHEM BOT: SELL ALL POSITIONS ===\n');

  const keypair = decryptWallet(walletPath, walletPassword);
  const connection = new Connection(rpcUrl, 'confirmed');
  const pk = keypair.publicKey;

  const balBefore = await connection.getBalance(pk);
  console.log(`Wallet: ${pk.toBase58()}`);
  console.log(`SOL balance: ${(balBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL\n`);

  // Fetch all token accounts
  const splAccounts = await connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID });
  const t2022Accounts = await connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM_ID });
  const allAccounts = [
    ...splAccounts.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t2022Accounts.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM_ID })),
  ];

  const withBalance: { mint: string; amount: number; decimals: number; pubkey: PublicKey; programId: PublicKey }[] = [];
  const emptyAccounts: { pubkey: PublicKey; programId: PublicKey }[] = [];

  for (const acct of allAccounts) {
    const info = acct.account.data.parsed.info;
    const amt = parseFloat(info.tokenAmount.uiAmountString || '0');
    const rawAmt = parseFloat(info.tokenAmount.amount || '0');
    if (rawAmt > 0) {
      withBalance.push({
        mint: info.mint,
        amount: rawAmt,
        decimals: info.tokenAmount.decimals,
        pubkey: acct.pubkey,
        programId: acct.programId,
      });
    } else {
      emptyAccounts.push({ pubkey: acct.pubkey, programId: acct.programId });
    }
  }

  console.log(`Found ${withBalance.length} tokens with balance, ${emptyAccounts.length} empty accounts\n`);

  // Sell each token
  let sold = 0;
  let failed = 0;
  for (const token of withBalance) {
    const humanAmt = token.amount / Math.pow(10, token.decimals);
    console.log(`Selling ${token.mint.slice(0, 12)}... (${humanAmt.toFixed(2)} tokens)`);

    try {
      let sig: string | null = null;

      if (isPumpFun(token.mint)) {
        // Use raw token amount for pump.fun (it expects human-readable)
        sig = await sellViaPumpFun(token.mint, humanAmt, keypair, connection);
      }

      // Fallback to Jupiter if pump.fun fails or not a pump token
      if (!sig) {
        sig = await sellViaJupiter(token.mint, token.amount, keypair, connection);
      }

      if (sig) {
        console.log(`  âœ“ Sold! tx: ${sig.slice(0, 30)}...`);
        sold++;
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`  âœ— No route / failed`);
        failed++;
      }
    } catch (err) {
      console.log(`  âœ— Error: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  // Close empty accounts (including ones just sold)
  console.log(`\nClosing empty token accounts to recover rent...`);
  await new Promise(r => setTimeout(r, 3000)); // wait for sells to finalize

  // Re-fetch to find newly emptied accounts
  const splAfter = await connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID });
  const t2022After = await connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_2022_PROGRAM_ID });
  const allAfter = [
    ...splAfter.value.map(a => ({ ...a, programId: TOKEN_PROGRAM_ID })),
    ...t2022After.value.map(a => ({ ...a, programId: TOKEN_2022_PROGRAM_ID })),
  ];

  const closeableAfter = allAfter.filter(a => {
    const rawAmt = parseFloat(a.account.data.parsed.info.tokenAmount.amount || '0');
    return rawAmt === 0;
  }).map(a => ({ pubkey: a.pubkey, programId: a.programId }));

  const closed = await closeEmptyAccounts(keypair, connection, closeableAfter);

  const balAfter = await connection.getBalance(pk);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Tokens sold: ${sold}`);
  console.log(`Failed/no route: ${failed}`);
  console.log(`Accounts closed: ${closed}`);
  console.log(`SOL before: ${(balBefore / LAMPORTS_PER_SOL).toFixed(6)}`);
  console.log(`SOL after:  ${(balAfter / LAMPORTS_PER_SOL).toFixed(6)}`);
  console.log(`Recovered:  ${((balAfter - balBefore) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});