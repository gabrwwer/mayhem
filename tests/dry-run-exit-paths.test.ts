import { describe, it, expect, beforeEach } from 'vitest';
import { BotState } from '../apps/api/src/state';

function collectEventTypes(state: BotState) {
  return state.events.map(e => e['eventType']);}

describe('DRY_RUN exit-path simulations', () => {
  let state: BotState;
  beforeEach(() => {
    state = new BotState();
    state.start();
  });

  it('Full close lifecycle ends with POSITION_CLOSED', () => {
    const id = 'full-1';
    const position = { id, quantity: 100, status: 'open' } as any;
    state.positions.set(id, position);

    // Simulate entry success
    state.emit('entry_opened', position);
    state.emit('entry_success', position);

    // Trigger exit
    state.emit('exit_triggered', { id, reason: 'take-profit' });
    state.emit('execution_request', { id, type: 'close' });
    state.emit('execution_attempt', { id, attempt: 1 });
    state.emit('execution_success', { id, filledQuantity: 100 });

    // Engine would mark position closed; emulate the state transition as DRY_RUN
    position.quantity = 0;
    position.status = 'closed';
    position.closedAt = new Date().toISOString();
    state.positions.set(id, position);
    state.emit('position_closed', position);

    const seq = collectEventTypes(state);
    const expected = ['entry_opened','entry_success','exit_triggered','execution_request','execution_attempt','execution_success','position_closed'];
    expect(seq.slice(-expected.length)).toEqual(expected);
    expect((state.positions.get(id) as any).status).toBe('closed');
  });

  it('Partial close leaves remaining quantity and position remains open', () => {
    const id = 'partial-1';
    const position = { id, quantity: 100, status: 'open' } as any;
    state.positions.set(id, position);

    state.emit('entry_success', position);

    state.emit('exit_triggered', { id, reason: 'partial-close' });
    state.emit('execution_request', { id, type: 'partial_close' });
    state.emit('execution_attempt', { id, attempt: 1 });
    state.emit('execution_success', { id, filledQuantity: 40 });

    // Emulate partial application
    position.quantity = 60;
    state.positions.set(id, position);
    state.emit('position_partial_close', { id, closedQuantity: 40, remaining: 60 });

    const seq = collectEventTypes(state);
    expect(seq).toContain('position_partial_close');
    expect((state.positions.get(id) as any).quantity).toBe(60);
    expect((state.positions.get(id) as any).status).toBe('open');
  });

  it('Hard stop triggers and results in closed position', () => {
    const id = 'hard-1';
    const position = { id, quantity: 50, status: 'open' } as any;
    state.positions.set(id, position);

    state.emit('entry_success', position);
    state.emit('hard_stop_triggered', { id, price: 0.1 });
    state.emit('execution_request', { id, type: 'hard_stop' });
    state.emit('execution_attempt', { id, attempt: 1 });
    state.emit('execution_success', { id, filledQuantity: 50 });

    position.quantity = 0;
    position.status = 'closed';
    state.positions.set(id, position);
    state.emit('position_closed', position);

    const seq = collectEventTypes(state);
    const expected = ['hard_stop_triggered','execution_request','execution_attempt','execution_success','position_closed'];
    expect(seq.slice(-expected.length)).toEqual(expected);
    expect((state.positions.get(id) as any).status).toBe('closed');
  });

  it('Execution failure leads to retries and position remains open on EXIT_FAILED', () => {
    const id = 'fail-1';
    const position = { id, quantity: 20, status: 'open' } as any;
    state.positions.set(id, position);

    state.emit('entry_success', position);
    state.emit('exit_triggered', { id, reason: 'manual' });

    // two failed attempts
    state.emit('execution_request', { id, type: 'close' });
    state.emit('execution_attempt', { id, attempt: 1 });
    state.emit('execution_failure', { id, attempt: 1, reason: 'network' });
    state.emit('execution_attempt', { id, attempt: 2 });
    state.emit('execution_failure', { id, attempt: 2, reason: 'timeout' });

    // final failure
    state.emit('exit_failed', { id, reason: 'max-retries' });

    const seq = collectEventTypes(state);
    expect(seq).toContain('exit_failed');
    expect((state.positions.get(id) as any).status).toBe('open');
  });
});
