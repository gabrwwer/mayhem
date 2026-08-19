
export type CandidateStatus =
  | 'DETECTED'
  | 'VALIDATING'
  | 'REJECTED'
  | 'APPROVED'
  | 'PENDING_ENTRY'
  | 'OPEN'
  | 'EXITING'
  | 'CLOSED'
  | 'FAILED';

export interface StateTransition {
  from: CandidateStatus;
  to: CandidateStatus;
  reason: string;
  timestamp: number;
  riskScore?: number;
  price?: number;
}

export interface Candidate {
  id: string;
  tokenMint: string;
  source: string;
  detectedAt: number;
  status: CandidateStatus;
  transitions: StateTransition[];
  riskScore: number | null;
  rejectionReasons: string[];
  price: number | null;
  liquidity: number | null;
  positionId: string | null;
}

const VALID_TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  DETECTED: ['VALIDATING', 'REJECTED'],
  VALIDATING: ['APPROVED', 'REJECTED'],
  APPROVED: ['PENDING_ENTRY', 'REJECTED'],
  PENDING_ENTRY: ['OPEN', 'FAILED', 'REJECTED'],
  OPEN: ['EXITING', 'FAILED'],
  EXITING: ['CLOSED', 'FAILED'],
  CLOSED: [],
  REJECTED: [],
  FAILED: [],
};

export class CandidateManager {
  private candidates = new Map<string, Candidate>();
  private seenMints = new Set<string>();
  private maxCandidates = 500;

  isDuplicate(tokenMint: string): boolean {
    return this.seenMints.has(tokenMint);
  }

  create(tokenMint: string, source: string): Candidate {
    this.seenMints.add(tokenMint);

    const candidate: Candidate = {
      id: `${tokenMint}-${Date.now()}`,
      tokenMint,
      source,
      detectedAt: Date.now(),
      status: 'DETECTED',
      transitions: [],
      riskScore: null,
      rejectionReasons: [],
      price: null,
      liquidity: null,
      positionId: null,
    };

    this.candidates.set(candidate.id, candidate);
    this.trimOld();
    return candidate;
  }

  transition(candidate: Candidate, to: CandidateStatus, reason: string, extra?: { riskScore?: number; price?: number }): boolean {
    const allowed = VALID_TRANSITIONS[candidate.status];
    if (!allowed || !allowed.includes(to)) {
      return false;
    }

    const t: StateTransition = {
      from: candidate.status,
      to,
      reason,
      timestamp: Date.now(),
      ...(extra?.riskScore !== undefined ? { riskScore: extra.riskScore } : {}),
      ...(extra?.price !== undefined ? { price: extra.price } : {}),
    };

    candidate.transitions.push(t);
    candidate.status = to;
    return true;
  }

  reject(candidate: Candidate, reason: string): void {
    candidate.rejectionReasons.push(reason);
    this.transition(candidate, 'REJECTED', reason);
  }

  getActive(): Candidate[] {
    return Array.from(this.candidates.values()).filter(
      (c) => c.status !== 'CLOSED' && c.status !== 'REJECTED' && c.status !== 'FAILED',
    );
  }

  getByMint(mint: string): Candidate | undefined {
    for (const c of this.candidates.values()) {
      if (c.tokenMint === mint && c.status !== 'CLOSED' && c.status !== 'REJECTED' && c.status !== 'FAILED') {
        return c;
      }
    }
    return undefined;
  }

  getStats() {
    const all = Array.from(this.candidates.values());
    return {
      total: all.length,
      detected: all.filter((c) => c.status === 'DETECTED').length,
      validating: all.filter((c) => c.status === 'VALIDATING').length,
      approved: all.filter((c) => c.status === 'APPROVED').length,
      rejected: all.filter((c) => c.status === 'REJECTED').length,
      open: all.filter((c) => c.status === 'OPEN').length,
      closed: all.filter((c) => c.status === 'CLOSED').length,
      failed: all.filter((c) => c.status === 'FAILED').length,
    };
  }

  private trimOld(): void {
    if (this.candidates.size <= this.maxCandidates) return;
    const entries = Array.from(this.candidates.entries())
      .sort((a, b) => a[1].detectedAt - b[1].detectedAt);
    const toRemove = entries.slice(0, entries.length - this.maxCandidates);
    for (const [id] of toRemove) {
      this.candidates.delete(id);
    }
  }
}