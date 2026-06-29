// Node reliability scoring . A 0..1 score from a node's
// history, fed into the matching engine's ranking. Mismatches (wrong output in
// a redundancy check — i.e. cheating/faulty) weigh more than mere timeouts.

export interface NodeStats {
  completed: number;
  timedOut: number;
  mismatched: number;
}

const MISMATCH_WEIGHT = 2; // a wrong result is twice as damaging as a timeout

/**
 * Laplace-smoothed reliability in [0,1]. A node with no history scores 0.5
 * (neutral) so it can earn its way up without being starved.
 */
export function reliabilityScore(s: NodeStats): number {
  const completed = nonNeg(s.completed);
  const good = completed;
  const bad = nonNeg(s.timedOut) + MISMATCH_WEIGHT * nonNeg(s.mismatched);
  if (good + bad === 0) return 0.5;
  // +1/+2 smoothing keeps small samples away from 0/1 extremes.
  return clamp01((good + 1) / (good + bad + 2));
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
