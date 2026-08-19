
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { LedgerEntrySchema, type LedgerEntry } from './entry.js';

/**
 * Append-only storage.
 *
 * Implementations must reject any write whose sequence is not the next one:
 * an overwrite is indistinguishable from tampering, and the ledger's whole
 * value is that it cannot be rewritten.
 */
export interface LedgerStore {
  size(): Promise<number>;
  last(): Promise<LedgerEntry | undefined>;
  append(entry: LedgerEntry): Promise<void>;
  read(): Promise<readonly LedgerEntry[]>;
}

export class LedgerAppendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerAppendError';
  }
}

export class InMemoryLedgerStore implements LedgerStore {
  readonly #entries: LedgerEntry[] = [];

  size(): Promise<number> {
    return Promise.resolve(this.#entries.length);
  }

  last(): Promise<LedgerEntry | undefined> {
    return Promise.resolve(this.#entries.at(-1));
  }

  append(entry: LedgerEntry): Promise<void> {
    if (entry.sequence !== this.#entries.length) {
      return Promise.reject(
        new LedgerAppendError(
          `expected sequence ${String(this.#entries.length)}, got ${String(entry.sequence)}`,
        ),
      );
    }
    this.#entries.push(entry);

    return Promise.resolve();
  }

  read(): Promise<readonly LedgerEntry[]> {
    return Promise.resolve([...this.#entries]);
  }
}

/**
 * JSON Lines store. One entry per line, opened for append only, so a crash
 * mid-write truncates at a line boundary rather than corrupting history.
 */
export class FileLedgerStore implements LedgerStore {
  readonly #path: string;
  #cache: LedgerEntry[] | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<LedgerEntry[]> {
    if (this.#cache !== undefined) return this.#cache;

    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      contents = '';
    }

    this.#cache = contents
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => {
        const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          throw new LedgerAppendError(
            `ledger line ${String(index + 1)} is not a valid entry: ${parsed.error.message}`,
          );
        }

        return parsed.data;
      });

    return this.#cache;
  }

  async size(): Promise<number> {
    return (await this.#load()).length;
  }

  async last(): Promise<LedgerEntry | undefined> {
    return (await this.#load()).at(-1);
  }

  async append(entry: LedgerEntry): Promise<void> {
    const entries = await this.#load();
    if (entry.sequence !== entries.length) {
      throw new LedgerAppendError(
        `expected sequence ${String(entries.length)}, got ${String(entry.sequence)}`,
      );
    }

    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    entries.push(entry);
  }

  async read(): Promise<readonly LedgerEntry[]> {
    return [...(await this.#load())];
  }
}