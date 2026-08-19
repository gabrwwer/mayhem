
export interface AccountingEntry {
  id: string;
  description: string;
  amount: number;
  currency: 'SOL' | 'USDC' | 'USD';
  recordedAt: string;
}

export interface RevenueSummary {
  totalRevenue: number;
  eventCount: number;
  currencies: Record<string, number>;
}

export class AccountingService {
  private readonly entries: AccountingEntry[] = [];

  recordEntry(entry: AccountingEntry): AccountingEntry {
    this.entries.push(entry);
    return entry;
  }

  getRevenueSummary(): RevenueSummary {
    const currencies = this.entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.currency] = (acc[entry.currency] ?? 0) + entry.amount;
      return acc;
    }, {});

    return {
      totalRevenue: this.entries.reduce((sum, entry) => sum + entry.amount, 0),
      eventCount: this.entries.length,
      currencies,
    };
  }

  listEntries(): AccountingEntry[] {
    return [...this.entries];
  }
}

export const accountingService = new AccountingService();