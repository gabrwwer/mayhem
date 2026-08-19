export declare function signInternalPayload(secret: string, timestamp: number, rawBody: string): string;
export type InternalObservation = Record<string, unknown>;
/**
 * Post a signed observation to the API `/internal/flow` endpoint.
 * Best-effort: never throws, never delays the caller.
 */
export declare function postInternalFlow(obs: InternalObservation): Promise<void>;
//# sourceMappingURL=index.d.ts.map