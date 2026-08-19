
#!/usr/bin/env ts-node
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { Keypair } from '@solana/web3.js';

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

function encrypt(secretKey: Uint8Array, password: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secretKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decrypt(payload: Buffer, password: string): Uint8Array {
  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = payload.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + 16);
  const encrypted = payload.subarray(SALT_LENGTH + IV_LENGTH + 16);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptPassword(rl: readline.Interface, label: string): Promise<string> {
  const pw = await prompt(rl, label);
  if (pw.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  return pw;
}

function resolveFilePath(input?: string): string {
  if (input) return path.resolve(input);
  return path.join(os.homedir(), '.mayhem', 'wallet.enc');
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function cmdCreate(args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const filePath = resolveFilePath(args[0]);

    if (fs.existsSync(filePath)) {
      console.error(`File already exists: ${filePath}`);
      console.error('Use "rotate" to change password or delete the file first.');
      process.exit(1);
    }

    const password = await promptPassword(rl, 'Enter encryption password (min 8 chars): ');
    const confirm = await prompt(rl, 'Confirm password: ');

    if (password !== confirm) {
      console.error('Passwords do not match.');
      process.exit(1);
    }

    const keypair = Keypair.generate();
    const payload = encrypt(keypair.secretKey, password);

    ensureDir(filePath);
    fs.writeFileSync(filePath, payload);
    fs.chmodSync(filePath, 0o600);

    console.log('');
    console.log('Wallet created successfully.');
    console.log(`  File:       ${filePath}`);
    console.log(`  Public key: ${keypair.publicKey.toBase58()}`);
    console.log('');
    console.log('IMPORTANT: Fund this address with SOL before enabling live trading.');
    console.log('Add to your .env:');
    console.log(`  WALLET_FILE_PATH=${filePath}`);
    console.log('  WALLET_PASSWORD=<your-password>');
  } finally {
    rl.close();
  }
}

async function cmdInfo(args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const filePath = resolveFilePath(args[0]);

    if (!fs.existsSync(filePath)) {
      console.error(`Wallet file not found: ${filePath}`);
      process.exit(1);
    }

    const password = await promptPassword(rl, 'Enter password: ');
    const payload = fs.readFileSync(filePath);

    let secretKey: Uint8Array;
    try {
      secretKey = decrypt(payload, password);
    } catch {
      console.error('Decryption failed. Wrong password or corrupted file.');
      process.exit(1);
    }

    const keypair = Keypair.fromSecretKey(secretKey);
    console.log('');
    console.log(`  File:       ${filePath}`);
    console.log(`  Public key: ${keypair.publicKey.toBase58()}`);
    console.log(`  Algorithm:  AES-256-GCM + PBKDF2 (${PBKDF2_ITERATIONS} iterations)`);

    crypto.randomFillSync(secretKey);
  } finally {
    rl.close();
  }
}

async function cmdRotate(args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const filePath = resolveFilePath(args[0]);

    if (!fs.existsSync(filePath)) {
      console.error(`Wallet file not found: ${filePath}`);
      process.exit(1);
    }

    const oldPassword = await promptPassword(rl, 'Enter current password: ');
    const payload = fs.readFileSync(filePath);

    let secretKey: Uint8Array;
    try {
      secretKey = decrypt(payload, oldPassword);
    } catch {
      console.error('Decryption failed. Wrong password or corrupted file.');
      process.exit(1);
    }

    const newPassword = await promptPassword(rl, 'Enter new password (min 8 chars): ');
    const confirm = await prompt(rl, 'Confirm new password: ');

    if (newPassword !== confirm) {
      console.error('Passwords do not match.');
      crypto.randomFillSync(secretKey);
      process.exit(1);
    }

    const backupPath = filePath + '.bak';
    fs.copyFileSync(filePath, backupPath);

    const newPayload = encrypt(secretKey, newPassword);
    fs.writeFileSync(filePath, newPayload);
    fs.chmodSync(filePath, 0o600);

    crypto.randomFillSync(secretKey);
    fs.unlinkSync(backupPath);

    const keypair = Keypair.fromSecretKey(decrypt(fs.readFileSync(filePath), newPassword));
    console.log('');
    console.log('Password rotated successfully.');
    console.log(`  Public key: ${keypair.publicKey.toBase58()}`);
    console.log('Update WALLET_PASSWORD in your .env file.');
  } finally {
    rl.close();
  }
}

function printUsage(): void {
  console.log('Mayhem Bot Wallet CLI');
  console.log('');
  console.log('Usage:');
  console.log('  npx ts-node scripts/wallet-cli.ts create [path]    Create a new encrypted wallet');
  console.log('  npx ts-node scripts/wallet-cli.ts info [path]      Show wallet public key');
  console.log('  npx ts-node scripts/wallet-cli.ts rotate [path]    Change wallet password');
  console.log('');
  console.log('Default path: ~/.mayhem/wallet.enc');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'create':
      await cmdCreate(args);
      break;
    case 'info':
      await cmdInfo(args);
      break;
    case 'rotate':
      await cmdRotate(args);
      break;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});