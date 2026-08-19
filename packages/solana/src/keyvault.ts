
import { Keypair } from "@solana/web3.js";
import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// scryptSync enforces 128*N*r <= maxmem. With N=2^15 and r=8 that is
// exactly the 32 MiB default, which leaves no headroom — raise maxmem
// explicitly rather than depending on an equality that a future Node
// release could turn into a boot-time throw.
const KDF = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/**
 * Vault ids become filenames. Without this an id containing `..` or a path
 * separator would let a caller read or overwrite an arbitrary file as the
 * bot user.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeId(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      'keyvault: id must match [A-Za-z0-9_-]{1,64} (got an unsafe or empty id)',
    );
  }
  return id;
}

interface VaultFile {
  v: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export class KeyVault {
  constructor(private readonly dir: string) {}

  save(keypair: Keypair, id: string, password: string): void {
    assertSafeId(id);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(password, salt, KDF.keylen, KDF);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(keypair.secretKey), cipher.final()]);
    const file: VaultFile = {
      v: 1,
      kdf: "scrypt",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ct: ct.toString("hex"),
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${id}.key`), JSON.stringify(file), { mode: 0o600 });
    key.fill(0); // zeroize derived key
  }

  load(id: string, password: string): Keypair {
    assertSafeId(id);
    const path = join(this.dir, `${id}.key`);
    if (!existsSync(path)) throw new Error(`keyvault: no key "${id}" at ${path}`);
    const file = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
    const key = scryptSync(password, Buffer.from(file.salt, "hex"), KDF.keylen, KDF);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.iv, "hex"));
    decipher.setAuthTag(Buffer.from(file.tag, "hex")); // GCM: wrong password throws here
    const secret = Buffer.concat([
      decipher.update(Buffer.from(file.ct, "hex")),
      decipher.final(),
    ]);
    const kp = Keypair.fromSecretKey(secret);
    secret.fill(0);
    key.fill(0);
    return kp;
  }
}