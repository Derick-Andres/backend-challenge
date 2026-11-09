export interface ReferencePolicy { ttlMs: number; baseDelayMs: number; maxDelayMs: number }
export const defaultReferencePolicy: Readonly<ReferencePolicy> = Object.freeze({ ttlMs: 86_400_000, baseDelayMs: 5000, maxDelayMs: 300_000 });
export interface ReferenceSchedule { attempts: number; nextAttemptAt: Date | undefined; expiresAt: Date }
