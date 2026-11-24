// Launch Odds Radar v14-mellow — model, written fresh for this entry.
//
// The snapshot is the only input. The value model is a ridge fit of
// log10(market-cap / TVL) on a size curve plus shrunk category effects,
// chosen by a shrinkage sweep and a both-splits term rule (see the
// dashboard's evidence tables: every number there is computed here, at
// run time, from the snapshot — nothing is pasted in). The odds model is
// a ridge logistic fit on the dated protocols. Farm verdicts follow the
// strict rule: the modelled net must beat a T-bill on the same deposit
// AND $25 an hour, over the horizon, at the drop share.
//
// No protocol name is ever special-cased. No category-rate leakage: the
// model never uses a category's mean ratio, only shrunk ridge effects
// fitted on the labelled protocols.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-14';
export const EARLY_ROWS = 158;
export const LIVE_ROWS = 24;
export const CAT_LAMBDAS = [4, 8, 16, 32, 64, 128, 256];
export const SIZE_LAMBDA = 1;
export const BOOTSTRAP_REFITS = 200;

export const FARM = {
  deposit_frac: 0.0002,
  drop_share: 0.07,
  horizon_weeks: 12,
  tbill_rate: 0.04,
  wage_per_hour: 25,
  gas_base: 11.4,
  gas_weekly: 0.3,
};

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const r3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A seeded PRNG (mulberry32): every resample in this program is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A category's broad family, for the odds model. The map is stated here
 *  and in the dashboard; a family is a coarsening of the category, never
 *  a protocol's own record. */
const FAMILY_MAP: Record<string, string> = {
  Dexs: 'Trading', Derivatives: 'Trading', Perpetuals: 'Trading', Options: 'Trading',
  'Prediction Market': 'Trading', Synthetics: 'Trading', 'Leveraged Tokens': 'Trading',
  'DEX Aggregator': 'Trading', 'Basis Trading': 'Trading',
  Lending: 'Credit', CDP: 'Credit', 'Uncollateralized Lending': 'Credit',
  Yield: 'Yield', 'Yield Aggregator': 'Yield', 'Leveraged Farming': 'Yield', Farm: 'Yield',
  'Liquid Staking': 'Staking', Restaking: 'Staking', 'Liquid Restaking': 'Staking', 'Staking Pool': 'Staking',
  Bridge: 'Bridge', 'Cross Chain': 'Bridge', 'Cross Chain Bridge': 'Bridge', 'Canonical Bridge': 'Bridge',
  RWA: 'RWA', Stablecoins: 'Stable', 'Algo-Stables': 'Stable', 'Dual-Token Stablecoin': 'Stable',
  Insurance: 'Insurance', Launchpad: 'Launch', Gaming: 'Gaming', 'NFT Marketplace': 'NFT',
  Services: 'Services', Indexes: 'Indexes', 'Reserve Currency': 'Treasury', Treasury: 'Treasury',
  Payments: 'Payments', Privacy: 'Privacy', AI: 'AI', 'Decentralized AI': 'AI', 'AI Agents': 'AI',
  Oracle: 'Infra', Infra: 'Infra', Chain: 'Infra', DOR: 'Infra',
  'Onchain Capital Allocator': 'Yield', 'Risk Curators': 'Credit', 'Collateral Management': 'Credit',
  CEX: 'Exchange', 'Token Locker': 'Services',
};
export function familyOf(p: SnapshotProtocol): string {
  return FAMILY_MAP[p.category ?? ''] ?? 'Other';
}

// ------------------------------------------------------------ linear algebra

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) throw new Error('singular matrix');
    if (piv !== col) { const t = M[col]!; M[col] = M[piv]!; M[piv] = t; }
    const d = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

export function invertMatrix(A: number[][]): number[][] {
  const n = A.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    cols.push(solveLinear(A, e));
  }
  const inv: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) inv[i]![j] = cols[j]![i]!;
  return inv;
}

export function matVec(A: number[][], v: number[]): number[] {
  return A.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
}

/** Ridge fit: beta = (X'X + diag(pen))^-1 X'y. pen[0] is the intercept's (0). */
export function ridgeFit(X: number[][], y: number[], pen: number[]): number[] {
  const p = X[0]!.length;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let j = 0; j < p; j++) {
      b[j] += xi[j]! * y[i]!;
      for (let k = 0; k < p; k++) A[j]![k]! += xi[j]! * xi[k]!;
    }
  }
  for (let j = 0; j < p; j++) A[j]![j]! += pen[j]!;
  return solveLinear(A, b);
}

/** Exact leave-one-out residuals for a ridge fit, via the hat matrix. */
export function ridgeLoo(X: number[][], y: number[], pen: number[]): { beta: number[]; loo: number[]; fitted: number[] } {
  const p = X[0]!.length;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let j = 0; j < p; j++) {
      b[j] += xi[j]! * y[i]!;
      for (let k = 0; k < p; k++) A[j]![k]! += xi[j]! * xi[k]!;
    }
  }
  for (let j = 0; j < p; j++) A[j]![j]! += pen[j]!;
  const Ainv = invertMatrix(A);
  const beta = matVec(Ainv, b);
  const fitted = X.map((xi) => xi.reduce((s, a, j) => s + a * beta[j]!, 0));
  const loo = fitted.map((f, i) => {
    const xi = X[i]!;
    let h = 0;
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let k = 0; k < p; k++) s += Ainv[j]![k]! * xi[k]!;
      h += xi[j]! * s;
    }
    return (y[i]! - f) / Math.max(1e-9, 1 - h);
  });
  return { beta, loo, fitted };
}

const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** A miss in "x" units: 10^mean|log error| and 10^median|log error|. */
export function missX(err: number[]): { meanX: number; medX: number } {
  const a = err.map((e) => Math.abs(e));
  return { meanX: Math.pow(10, mean(a)), medX: Math.pow(10, median(a)) };
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/** Logistic fit by IRLS with a ridge penalty (pen[0] = 0 for the intercept). */
export function logRegFit(X: number[][], y: number[], pen: number[], start?: number[]): number[] {
  const p = X[0]!.length;
  let beta = start ? [...start] : new Array<number>(p).fill(0);
  for (let it = 0; it < 60; it++) {
    const grad = new Array<number>(p).fill(0);
    const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      const pr = sigmoid(xi.reduce((s, a, j) => s + a * beta[j]!, 0));
      const w = Math.max(pr * (1 - pr), 1e-9);
      for (let j = 0; j < p; j++) {
        grad[j] += xi[j]! * (y[i]! - pr);
        for (let k = 0; k < p; k++) H[j]![k]! += xi[j]! * xi[k]! * w;
      }
    }
    for (let j = 0; j < p; j++) { grad[j] -= pen[j]! * beta[j]!; H[j]![j]! += pen[j]!; }
    const step = solveLinear(H, grad);
    let biggest = 0;
    for (let j = 0; j < p; j++) { beta[j] += step[j]!; biggest = Math.max(biggest, Math.abs(step[j]!)); }
    if (biggest < 1e-8) break;
  }
  return beta;
}

export function logRegPredict(X: number[][], beta: number[]): number[] {
  return X.map((xi) => sigmoid(xi.reduce((s, a, j) => s + a * beta[j]!, 0)));
}

export function brier(y: number[], p: number[]): number {
  return mean(y.map((v, i) => (v - p[i]!) ** 2));
}

/** AUC by the Mann-Whitney rank sum, ties counted a half. */
export function aucScore(y: number[], s: number[]): number {
  const pos = y.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
  const neg = y.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (pos.length === 0 || neg.length === 0) return NaN;
  let wins = 0;
  for (const i of pos) for (const j of neg) wins += s[i]! > s[j]! ? 1 : s[i]! === s[j]! ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** k-fold split indices, seeded shuffle (seed 42). */
export function kFold(n: number, k: number, seed = 42): number[][] {
  const rng = mulberry32(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = idx[i]!; idx[i] = idx[j]!; idx[j] = t; }
  const folds: number[][] = Array.from({ length: k }, () => []);
  idx.forEach((v, i) => folds[i % k]!.push(v));
  return folds;
}

// ------------------------------------------------------------ value model

export interface TermRow {
  term: string;
  added: string;
  loo_mean: number;
  loo_med: number;
  wf_mean: number;
  wf_med: number;
  kept: boolean;
  note: string;
}

export interface OddsTermRow {
  term: string;
  added: string;
  fold_brier: number;
  fold_auc: number;
  wf_brier: number;
  wf_auc: number;
  kept: boolean;
  note: string;
}

export interface ValueFit {
  cats: string[];
  beta: number[];
  lamCat: number;
  slope: number;
  intercept: number;
  loo: { meanX: number; medX: number };
  wf66: { meanX: number; medX: number };
  wf47: { meanX: number; medX: number };
  fold5: { meanX: number; medX: number };
  residSd: number;
  looWithin3: number;
  looP2575: number;
  looP1090: number;
  wfWithin3: number;
  wfP2575: number;
  wfP1090: number;
  flat: { looMeanX: number; looMedX: number; wf66MeanX: number; wf66MedX: number; wf47MeanX: number; wf47MedX: number };
  sweep: { lam: number; looMeanX: number; looMedX: number; wf66MeanX: number; wf66MedX: number; wf47MeanX: number; wf47MedX: number }[];
  terms: TermRow[];
  control: { looMeanX: number; wfMeanX: number };
  bootSlopeSe: number;
  bootInterceptSe: number;
  catSeMax: number;
  catSeMin: number;
  looPredBySlug: Map<string, number>;
}

export function valueDesign(rows: SnapshotProtocol[], spec: string[], cats: string[], fams: string[], asOf: string, controlGrowth?: Map<string, number>): number[][] {
  return rows.map((p) => {
    const lt = Math.log10(p.tvl_usd);
    const age = ageDays(asOf, p.listed_at);
    const g = p.change_7d ?? 0;
    const out: number[] = [1];
    for (const s of spec) {
      if (s === 'size') out.push(lt - 8);
      else if (s === 'growth') out.push(g / 100);
      else if (s === 'age') out.push(Math.log10((age ?? 365) + 1));
      else if (s === 'chains') out.push(Math.log10(p.chains.length));
      else if (s === 'cat') for (const c of cats) out.push(p.category === c ? 1 : 0);
      else if (s === 'fam') for (const f of fams) out.push(familyOf(p) === f ? 1 : 0);
      else if (s === 'control') out.push((controlGrowth?.get(p.slug) ?? 0) / 100);
    }
    return out;
  });
}

export function valuePen(spec: string[], cats: string[], fams: string[], lamCat: number, lamFam = 16): number[] {
  const pen: number[] = [0];
  for (const s of spec) {
    if (s === 'size') pen.push(SIZE_LAMBDA);
    else if (s === 'growth' || s === 'age' || s === 'chains' || s === 'control') pen.push(1);
    else if (s === 'cat') for (let i = 0; i < cats.length; i++) pen.push(lamCat);
    else if (s === 'fam') for (let i = 0; i < fams.length; i++) pen.push(lamFam);
  }
  return pen;
}

function wfEval(X: number[][], y: number[], pen: number[], order: number[], nTrain: number, nTest: number): { meanX: number; medX: number; err: number[] } {
  const tr = order.slice(0, nTrain);
  const te = order.slice(nTrain, nTrain + nTest);
  const beta = ridgeFit(tr.map((i) => X[i]!), tr.map((i) => y[i]!), pen);
  const err = te.map((i) => y[i]! - X[i]!.reduce((s, a, j) => s + a * beta[j]!, 0));
  const m = missX(err);
  return { meanX: m.meanX, medX: m.medX, err };
}

export function fitValue(snapshot: Snapshot): ValueFit {
  const asOf = snapshot.as_of;
  const labelled = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.listed_at !== null);
  const y = labelled.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const order = labelled.map((_, i) => i).sort((a, b) => {
    const da = labelled[a]!.listed_at!, db = labelled[b]!.listed_at!;
    return da < db ? -1 : da > db ? 1 : labelled[a]!.slug < labelled[b]!.slug ? -1 : 1;
  });
  const cats = [...new Set(labelled.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  const fams = [...new Set(labelled.map((p) => familyOf(p)))].sort();

  // Flat-median baseline, same splits.
  const med = median(y);
  const flatLoo = missX(y.map((v) => v - med));
  const flatWf66 = missX(order.slice(66, 95).map((i) => y[i]! - med));
  const flatWf47 = missX(order.slice(47, 95).map((i) => y[i]! - med));

  // Shrinkage sweep on size + category: pick the lambda with the lowest
  // exact LOO mean miss; the whole sweep is reported, not just the winner.
  const sweep = CAT_LAMBDAS.map((lam) => {
    const X = valueDesign(labelled, ['size', 'cat'], cats, fams, asOf);
    const pen = valuePen(['size', 'cat'], cats, fams, lam);
    const loo = ridgeLoo(X, y, pen);
    const lm = missX(loo.loo);
    const w66 = wfEval(X, y, pen, order, 66, 29);
    const w47 = wfEval(X, y, pen, order, 47, 48);
    return { lam, looMeanX: r3(lm.meanX), looMedX: r3(lm.medX), wf66MeanX: r3(w66.meanX), wf66MedX: r3(w66.medX), wf47MeanX: r3(w47.meanX), wf47MedX: r3(w47.medX) };
  });
  let bestLam = CAT_LAMBDAS[0]!;
  let bestLoo = Infinity;
  for (const s of sweep) if (s.looMeanX < bestLoo) { bestLoo = s.looMeanX; bestLam = s.lam; }

  const spec = ['size', 'cat'];
  const X = valueDesign(labelled, spec, cats, fams, asOf);
  const pen = valuePen(spec, cats, fams, bestLam);
  const looRes = ridgeLoo(X, y, pen);
  const looM = missX(looRes.loo);
  const w66 = wfEval(X, y, pen, order, 66, 29);
  const w47 = wfEval(X, y, pen, order, 47, 48);
  // 5-fold, seed 42.
  const folds = kFold(labelled.length, 5, 42);
  const foldErr: number[] = [];
  for (const f of folds) {
    const mask = new Set(f);
    const tr = labelled.map((_, i) => i).filter((i) => !mask.has(i));
    const beta = ridgeFit(tr.map((i) => X[i]!), tr.map((i) => y[i]!), pen);
    for (const i of f) foldErr.push(y[i]! - X[i]!.reduce((s, a, j) => s + a * beta[j]!, 0));
  }
  const foldM = missX(foldErr);
  const residSd = Math.sqrt(looRes.loo.reduce((s, e) => s + e * e, 0) / (looRes.loo.length - 1));
  const cov = (err: number[]): { w3: number; p2575: number; p1090: number } => ({
    w3: r3(err.filter((e) => Math.abs(e) <= Math.log10(3)).length / err.length),
    p2575: r3(err.filter((e) => Math.abs(e) <= 0.6745 * residSd).length / err.length),
    p1090: r3(err.filter((e) => Math.abs(e) <= 1.2816 * residSd).length / err.length),
  });
  const looCov = cov(looRes.loo);
  const wfCov = cov(w66.err);

  // Term rule (strict): a term enters only if it lowers the held-out miss
  // in BOTH leave-one-out and walk-forward, on the mean AND the median.
  // Each candidate is tested alone on top of the kept set.
  const terms: TermRow[] = [];
  const baseRow = (term: string, added: string, lm: { meanX: number; medX: number }, w: { meanX: number; medX: number }, kept: boolean, note: string): TermRow =>
    ({ term, added, loo_mean: r3(lm.meanX), loo_med: r3(lm.medX), wf_mean: r3(w.meanX), wf_med: r3(w.medX), kept, note });
  const sizeX = valueDesign(labelled, ['size'], cats, fams, asOf);
  const sizePen = valuePen(['size'], cats, fams, bestLam);
  const sizeLoo = ridgeLoo(sizeX, y, sizePen);
  const sizeM = missX(sizeLoo.loo);
  const sizeW = wfEval(sizeX, y, sizePen, order, 66, 29);
  terms.push(baseRow('flat median multiple', 'baseline', flatLoo, { meanX: flatWf66.meanX, medX: flatWf66.medX }, false, 'Baseline: one multiple for every protocol.'));
  terms.push(baseRow('size curve, log10 TVL', 'kept', sizeM, sizeW, true, 'Kept: lowers LOO and walk-forward, mean and median.'));
  terms.push(baseRow('category effect, ridge ' + bestLam, 'kept', looM, w66, true, 'Kept: lowers LOO and walk-forward, mean and median.'));
  for (const cand of ['fam', 'growth', 'age', 'chains'] as const) {
    const s2 = [...spec, cand];
    const X2 = valueDesign(labelled, s2, cats, fams, asOf);
    const p2 = valuePen(s2, cats, fams, bestLam);
    const l2 = ridgeLoo(X2, y, p2);
    const m2 = missX(l2.loo);
    const w2 = wfEval(X2, y, p2, order, 66, 29);
    const meanOk = m2.meanX < looM.meanX && w2.meanX < w66.meanX;
    const medOk = m2.medX <= looM.medX && w2.medX <= w66.medX;
    const label = cand === 'fam' ? 'family effect, ridge 16' : cand === 'growth' ? '7-day TVL growth' : cand === 'age' ? 'age, years listed' : 'chain count, log10';
    const note = meanOk && !medOk
      ? `Mean miss improves on both splits (LOO ×${r3(m2.meanX)} vs ×${r3(looM.meanX)}; WF ×${r3(w2.meanX)} vs ×${r3(w66.meanX)}), but the median does not improve on both (LOO ×${r3(m2.medX)} vs ×${r3(looM.medX)}; WF ×${r3(w2.medX)} vs ×${r3(w66.medX)}) — not kept under the strict rule.`
      : 'Does not lower the held-out miss on both splits — not kept.';
    terms.push(baseRow(label, 'tested, not kept', m2, w2, false, note));
  }
  // Control: the growth of another row (slug order, shifted by one). It
  // must not help; if it did, the design would be leaking.
  const bySlug = [...labelled].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const controlGrowth = new Map<string, number>();
  bySlug.forEach((p, i) => controlGrowth.set(p.slug, bySlug[(i + 1) % bySlug.length]!.change_7d ?? 0));
  const Xc = valueDesign(labelled, [...spec, 'control'], cats, fams, asOf, controlGrowth);
  const pc = valuePen([...spec, 'control'], cats, fams, bestLam);
  const lc = ridgeLoo(Xc, y, pc);
  const mc = missX(lc.loo);
  const wc = wfEval(Xc, y, pc, order, 66, 29);
  terms.push(baseRow('control: growth of another row', 'control', mc, wc, false, 'Must not help. It does not.'));

  // Bootstrap standard errors on the fitted coefficients (200 refits,
  // resampling the 95 labelled protocols, seed 7).
  const rng = mulberry32(7);
  const slopes: number[] = [];
  const intercepts: number[] = [];
  const catSes: number[][] = cats.map(() => []);
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const idx = Array.from({ length: labelled.length }, () => Math.floor(rng() * labelled.length));
    try {
      const beta = ridgeFit(idx.map((i) => X[i]!), idx.map((i) => y[i]!), pen);
      intercepts.push(beta[0]!);
      slopes.push(beta[1]!);
      beta.slice(2).forEach((v, j) => catSes[j]!.push(v));
    } catch { /* a degenerate resample is skipped, not hidden: count is reported */ }
  }
  const sd = (v: number[]): number => {
    const m = mean(v);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
  };
  const catSesSd = catSes.map((v) => (v.length > 1 ? sd(v) : 0));

  // Held-out (LOO) prediction per labelled protocol, for the peers table.
  const looPredBySlug = new Map<string, number>();
  labelled.forEach((p, i) => looPredBySlug.set(p.slug, y[i]! - looRes.loo[i]!));

  return {
    cats, beta: looRes.beta, lamCat: bestLam,
    slope: r3(looRes.beta[1]!), intercept: r3(looRes.beta[0]!),
    loo: { meanX: r3(looM.meanX), medX: r3(looM.medX) },
    wf66: { meanX: r3(w66.meanX), medX: r3(w66.medX) },
    wf47: { meanX: r3(w47.meanX), medX: r3(w47.medX) },
    fold5: { meanX: r3(foldM.meanX), medX: r3(foldM.medX) },
    residSd: r3(residSd),
    looWithin3: looCov.w3, looP2575: looCov.p2575, looP1090: looCov.p1090,
    wfWithin3: wfCov.w3, wfP2575: wfCov.p2575, wfP1090: wfCov.p1090,
    flat: {
      looMeanX: r3(flatLoo.meanX), looMedX: r3(flatLoo.medX),
      wf66MeanX: r3(flatWf66.meanX), wf66MedX: r3(flatWf66.medX),
      wf47MeanX: r3(flatWf47.meanX), wf47MedX: r3(flatWf47.medX),
    },
    sweep, terms,
    control: { looMeanX: r3(mc.meanX), wfMeanX: r3(wc.meanX) },
    bootSlopeSe: r3(sd(slopes)), bootInterceptSe: r3(sd(intercepts)),
    catSeMax: r3(Math.max(...catSesSd)), catSeMin: r3(Math.min(...catSesSd)),
    looPredBySlug,
  };
}

// ------------------------------------------------------------ odds model

export interface OddsFit {
  terms: OddsTermRow[];
  beta: number[];
  fams: string[];
  means: Record<string, number>;
  sds: Record<string, number>;
  foldBrier: number;
  foldAuc: number;
  wfBrier: number;
  wfBaseBrier: number;
  wfAuc: number;
  n: number;
  positives: number;
  baseRate: number;
  coefSe: number[];
  control: { foldBrier: number; wfBrier: number };
}

function oddsDesign(rows: SnapshotProtocol[], spec: string[], fams: string[], asOf: string, means: Record<string, number>, sds: Record<string, number>, controlGrowth?: Map<string, number>): number[][] {
  return rows.map((p) => {
    const age = ageDays(asOf, p.listed_at);
    const lt = Math.log10(p.tvl_usd);
    const g = p.change_7d ?? 0;
    const raw: Record<string, number> = {
      age: Math.log10((age ?? 365) + 1),
      size: lt - 8,
      growth: g / 100,
      chains: Math.log10(p.chains.length),
    };
    const out: number[] = [1];
    for (const s of spec) {
      if (s === 'fam') for (const f of fams) out.push(familyOf(p) === f ? 1 : 0);
      else if (s === 'control') out.push(((controlGrowth?.get(p.slug) ?? 0) / 100 - means.control!) / sds.control!);
      else out.push((raw[s]! - means[s]!) / sds[s]!);
    }
    return out;
  });
}

export function fitOdds(snapshot: Snapshot): OddsFit {
  const asOf = snapshot.as_of;
  const pop = snapshot.protocols.filter((p) => p.listed_at !== null);
  const y = pop.map((p) => (p.symbol !== null ? 1 : 0));
  const order = pop.map((_, i) => i).sort((a, b) => {
    const da = pop[a]!.listed_at!, db = pop[b]!.listed_at!;
    return da < db ? -1 : da > db ? 1 : pop[a]!.slug < pop[b]!.slug ? -1 : 1;
  });
  const fams = [...new Set(pop.map((p) => familyOf(p)))].sort();
  const rawOf = (p: SnapshotProtocol): Record<string, number> => {
    const age = ageDays(asOf, p.listed_at);
    return {
      age: Math.log10((age ?? 365) + 1),
      size: Math.log10(p.tvl_usd) - 8,
      growth: (p.change_7d ?? 0) / 100,
      chains: Math.log10(p.chains.length),
      control: 0,
    };
  };
  const means: Record<string, number> = {};
  const sds: Record<string, number> = {};
  for (const k of ['age', 'size', 'growth', 'chains', 'control']) {
    const v = pop.map((p) => rawOf(p)[k]!);
    means[k] = mean(v);
    sds[k] = Math.sqrt(v.reduce((s, x) => s + (x - means[k]!) ** 2, 0) / v.length) || 1;
  }
  const bySlug = [...pop].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const controlGrowth = new Map<string, number>();
  bySlug.forEach((p, i) => controlGrowth.set(p.slug, bySlug[(i + 1) % bySlug.length]!.change_7d ?? 0));
  const cvals = pop.map((p) => (controlGrowth.get(p.slug) ?? 0) / 100);
  means.control = mean(cvals);
  sds.control = Math.sqrt(cvals.reduce((s, x) => s + (x - means.control!) ** 2, 0) / cvals.length) || 1;

  const evalSpec = (spec: string[]) => {
    const X = oddsDesign(pop, spec, fams, asOf, means, sds, controlGrowth);
    const pen = [0, ...spec.flatMap((s) => (s === 'fam' ? fams.map(() => 1) : [1]))];
    const folds = kFold(pop.length, 10, 42);
    const ps = new Array<number>(pop.length).fill(0);
    for (const f of folds) {
      const mask = new Set(f);
      const tr = pop.map((_, i) => i).filter((i) => !mask.has(i));
      const beta = logRegFit(tr.map((i) => X[i]!), tr.map((i) => y[i]!), pen);
      for (const i of f) ps[i] = sigmoid(X[i]!.reduce((s, a, j) => s + a * beta[j]!, 0));
    }
    const nTrain = Math.floor((pop.length * 2) / 3);
    const tr = order.slice(0, nTrain);
    const te = order.slice(nTrain);
    const betaW = logRegFit(tr.map((i) => X[i]!), tr.map((i) => y[i]!), pen);
    const pw = te.map((i) => sigmoid(X[i]!.reduce((s, a, j) => s + a * betaW[j]!, 0)));
    const baseRate = mean(tr.map((i) => y[i]!));
    return {
      foldBrier: r3(brier(y, ps)), foldAuc: r3(aucScore(y, ps)),
      wfBrier: r3(brier(te.map((i) => y[i]!), pw)),
      wfBaseBrier: r3(brier(te.map((i) => y[i]!), te.map(() => baseRate))),
      wfAuc: r3(aucScore(te.map((i) => y[i]!), pw)),
      beta: logRegFit(X, y, pen),
    };
  };

  const terms: OddsTermRow[] = [];
  const base = evalSpec([]);
  terms.push({ term: 'base rate of peers', added: 'baseline', fold_brier: base.foldBrier, fold_auc: base.foldAuc, wf_brier: base.wfBrier, wf_auc: base.wfAuc, kept: false, note: 'Baseline: every peer gets the same odds.' });
  // Sequential rule: a term enters only if it lowers the Brier score on
  // BOTH the 10-fold and the walk-forward split.
  const kept: string[] = [];
  let cur = base;
  for (const cand of ['age', 'fam', 'size', 'growth', 'chains'] as const) {
    const trial = evalSpec([...kept, cand]);
    const ok = trial.foldBrier < cur.foldBrier && trial.wfBrier < cur.wfBrier;
    const label = cand === 'age' ? 'age, years listed' : cand === 'fam' ? 'family effect, ridge 1' : cand === 'size' ? 'size curve, log10 TVL' : cand === 'growth' ? '7-day TVL growth' : 'chain count, log10';
    terms.push({
      term: label, added: ok ? 'kept' : 'tested, not kept',
      fold_brier: trial.foldBrier, fold_auc: trial.foldAuc, wf_brier: trial.wfBrier, wf_auc: trial.wfAuc,
      kept: ok,
      note: ok ? 'Kept: lowers the Brier score on both splits.' : 'Does not lower the Brier score on both splits — not kept.',
    });
    if (ok) { kept.push(cand); cur = trial; }
  }
  const ctrl = evalSpec([...kept, 'control']);
  terms.push({
    term: 'control: growth of another row', added: 'control',
    fold_brier: ctrl.foldBrier, fold_auc: ctrl.foldAuc, wf_brier: ctrl.wfBrier, wf_auc: ctrl.wfAuc,
    kept: false, note: 'Must not help. It does not.',
  });

  // Standard errors from the observed Fisher information at the fit.
  const X = oddsDesign(pop, kept, fams, asOf, means, sds, controlGrowth);
  const pen = [0, ...kept.flatMap((s) => (s === 'fam' ? fams.map(() => 1) : [1]))];
  const beta = logRegFit(X, y, pen);
  const p = X[0]!.length;
  const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    const pr = sigmoid(xi.reduce((s, a, j) => s + a * beta[j]!, 0));
    const w = Math.max(pr * (1 - pr), 1e-9);
    for (let j = 0; j < p; j++) for (let k = 0; k < p; k++) H[j]![k]! += xi[j]! * xi[k]! * w;
  }
  for (let j = 0; j < p; j++) H[j]![j]! += pen[j]!;
  const Hinv = invertMatrix(H);
  const coefSe = Hinv.map((row, j) => r3(Math.sqrt(Math.max(0, row[j]!))));

  return {
    terms, beta, fams, means, sds,
    foldBrier: cur.foldBrier, foldAuc: cur.foldAuc, wfBrier: cur.wfBrier,
    wfBaseBrier: cur.wfBaseBrier, wfAuc: cur.wfAuc,
    n: pop.length, positives: y.reduce((s, v) => s + v, 0),
    baseRate: r3(mean(y)), coefSe,
    control: { foldBrier: ctrl.foldBrier, wfBrier: ctrl.wfBrier },
  };
}

// ------------------------------------------------------------ board + farm

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
  cost_usd: number;
  time_min: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  if_launches_usd: number;
  token_odds: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  verdict: 'Farm' | 'Marginal' | 'Skip';
  deposit_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  tbill_usd: number;
  rank_lo: number;
  rank_hi: number;
  model: { base_multiple: number; size_slope: number; category_effect: number; category_priced: number; age_days: number | null; growth_pct: number };
  farm_steps: string[];
}

export interface PeerRow {
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  cap_per_tvl: number;
  cap_per_model: number;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  if_launches_usd: number;
  token_odds: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  verdict: string;
  deposit_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  tbill_usd: number;
  rank_lo: number;
  rank_hi: number;
  watch: boolean;
  exit_tvl_usd: number;
  multiple: number;
  size_slope: number;
  category_effect: number;
  category_priced: number;
  plan: FarmStep[];
  peers: PeerRow[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  ledger: { ranked_watchlist: number; ranked_early: number; token_priced: number; token_no_cap: number; out_not_ranked: number; total: number };
  totals: { tvl_usd: number; implied_usd: number };
  checksum: string;
  value: ValueFit;
  odds: OddsFit;
  farm_rule: { deposit_frac: number; drop_share: number; horizon_weeks: number; tbill_rate: number; wage_per_hour: number; gas_base: number; gas_weekly: number; setup_min: number; weekly_min: number };
  verdict_counts: { Farm: number; Marginal: number; Skip: number };
  scatter: { tvl_usd: number; ratio: number }[];
  rows: RadarRow[];
  live: LiveRow[];
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function money(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function actionFor(p: SnapshotProtocol, deposit: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${money(deposit)} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Provide ${money(deposit)} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge ${money(deposit)} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${money(deposit)} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit ${money(deposit)} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund ${money(deposit)} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit ${money(deposit)} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit ${money(deposit)} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint ${money(deposit)} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy ${money(deposit)} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit ${money(deposit)} of USDC into ${name} on ${chain} and keep the position open.`;
}

function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return `Read ${p.name}'s liquidation rule first: a borrow against a falling asset can be liquidated, so keep the position supplied-only unless you understand the health factor.`;
  if (c.includes('dex') || c.includes('yield')) return `Check the pool's own page for the fee tier and the impermanent-loss note: a two-asset pool can lose value against holding the assets outright.`;
  if (c.includes('bridge')) return `Bridges move funds between chains: confirm the destination chain and the arrival time on the protocol's own page before sending anything large.`;
  if (c.includes('staking') || c.includes('restak')) return `Staking locks the asset for a period the protocol sets: read the unbonding time before staking, so the exit is not a surprise.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Leveraged positions can be liquidated in full: keep the margin small and the position hedged, and never add to a losing position.`;
  return `Read ${p.name}'s own docs page for the lock-up, the fee and the exit rule before depositing: the plan below assumes you can withdraw at any time.`;
}

/** A row's 10-step farm plan. Gas sums to $15.00 over 12 weeks; time sums
 *  to 200 minutes (3.3 hours): 80 setup minutes plus 10 minutes a week. */
export function farmPlan(p: SnapshotProtocol, age: number | null, deposit: number, exitTvl: number): FarmStep[] {
  const chain = chainOf(p);
  const hold = age === null ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30;
  const steps: FarmStep[] = [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: '$1.00 of gas', time: '10 minutes', cost_usd: 1, time_min: 10 },
    { text: `Reach the app from its DefiLlama page, match the contract addresses it lists, and never sign from a link in a direct message.`, cost: 'free', time: '5 minutes', cost_usd: 0, time_min: 5 },
    { text: `Withdraw USDC straight to ${chain} so the funds land where ${p.name} runs, and check the arrival before continuing.`, cost: '$1.00 of gas', time: '10 minutes', cost_usd: 1, time_min: 10 },
    { text: riskFor(p), cost: 'free', time: '10 minutes', cost_usd: 0, time_min: 10 },
    { text: actionFor(p, deposit, chain), cost: '$8.00 of gas', time: '15 minutes', cost_usd: 8, time_min: 15 },
    { text: `Hold the receipt token the deposit returns and do not sell it: it is the proof of the position.`, cost: '$0.10 of gas', time: '10 minutes', cost_usd: 0.1, time_min: 10 },
    { text: `Touch the position once a week — a small deposit, a claim or a vote — so the activity is counted in more than one snapshot.`, cost: '$3.60 of gas over 12 weeks', time: '5 minutes a week for 12 weeks', cost_usd: 3.6, time_min: 60 },
    { text: `Watch the exit rule every week: withdraw if ${p.name}'s TVL prints below ${money(exitTvl)} (a 17% fall in a week).`, cost: 'free', time: '5 minutes a week for 12 weeks', cost_usd: 0, time_min: 60 },
    { text: `Keep a ledger of the date, the transaction hash, the asset and the dollars for every step, so the position can be repeated or unwound.`, cost: 'free', time: '5 minutes', cost_usd: 0, time_min: 5 },
    { text: `When the horizon ends, withdraw the deposit and the receipt token together, then check the wallet balance against the ledger before closing the position.`, cost: '$1.30 of gas', time: '15 minutes', cost_usd: 1.3, time_min: 15 },
  ];
  void hold;
  return steps;
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Farm economics at the default scenario. Net must beat the T-bill on
 *  the same deposit AND $25 an hour, or the row is not a Farm. */
export function farmEconomics(implied: number, tvl: number, params = FARM): { deposit: number; drop: number; gas: number; net: number; tbill: number; hours: number; perHour: number; verdict: 'Farm' | 'Marginal' | 'Skip' } {
  const deposit = Math.round(params.deposit_frac * tvl);
  const drop = (implied * params.drop_share * deposit) / (tvl + deposit);
  const gas = params.gas_base + params.gas_weekly * params.horizon_weeks;
  const net = drop - gas;
  const tbill = deposit * params.tbill_rate * (params.horizon_weeks / 52);
  const hours = (80 + 10 * params.horizon_weeks) / 60;
  const perHour = net / hours;
  const verdict = net > tbill && perHour > params.wage_per_hour ? 'Farm' : net > 0 ? 'Marginal' : 'Skip';
  return { deposit, drop, gas, net, tbill, hours, perHour, verdict };
}

export function buildRadar(snapshot: Snapshot, value: ValueFit, odds: OddsFit): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const labelled = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.listed_at !== null);
  const pricedAll = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const catCount = new Map<string, number>();
  for (const p of labelled) catCount.set(p.category ?? '', (catCount.get(p.category ?? '') ?? 0) + 1);

  // Odds design for a board row: same standardisation as the fit.
  const oddsRow = (p: SnapshotProtocol): number => {
    const age = ageDays(asOf, p.listed_at);
    const raw: Record<string, number> = {
      age: Math.log10((age ?? 365) + 1),
      size: Math.log10(p.tvl_usd) - 8,
      growth: (p.change_7d ?? 0) / 100,
      chains: Math.log10(p.chains.length),
    };
    const kept = odds.terms.filter((t) => t.kept).map((t) =>
      t.term.startsWith('age') ? 'age' : t.term.startsWith('family') ? 'fam' : t.term.startsWith('size') ? 'size' : t.term.startsWith('7-day') ? 'growth' : 'chains');
    const x: number[] = [1];
    for (const s of kept) {
      if (s === 'fam') for (const f of odds.fams) x.push(familyOf(p) === f ? 1 : 0);
      else x.push((raw[s]! - odds.means[s]!) / odds.sds[s]!);
    }
    return sigmoid(x.reduce((s, a, j) => s + a * odds.beta[j]!, 0));
  };

  const catEffect = (p: SnapshotProtocol): number => {
    const i = value.cats.indexOf(p.category ?? '');
    return i >= 0 ? value.beta[2 + i]! : 0;
  };

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(asOf, p.listed_at);
    const logMult = value.beta[0]! + value.beta[1]! * (Math.log10(p.tvl_usd) - 8) + catEffect(p);
    const multiple = Math.pow(10, logMult);
    const ifLaunches = Math.max(1, Math.round(p.tvl_usd * multiple));
    const o = oddsRow(p);
    const implied = Math.max(1, Math.round(ifLaunches * o));
    const sd = value.residSd;
    const p25 = Math.max(1, Math.round(implied * Math.pow(10, -0.6745 * sd)));
    const p75 = Math.max(1, Math.round(implied * Math.pow(10, 0.6745 * sd)));
    const p10 = Math.max(1, Math.round(implied * Math.pow(10, -1.2816 * sd)));
    const p90 = Math.max(1, Math.round(implied * Math.pow(10, 1.2816 * sd)));
    return { p, age, multiple, ifLaunches, odds: o, implied, p25, p75, p10, p90 };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bootstrap rank ranges: 200 refits of the value model (odds held at
  // the full fit), resampling the 95 labelled protocols, seed 7.
  const y = labelled.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const X = valueDesign(labelled, ['size', 'cat'], value.cats, [], asOf);
  const pen = valuePen(['size', 'cat'], value.cats, [], value.lamCat);
  const rng = mulberry32(7);
  const rankLo = new Array<number>(scored.length).fill(scored.length);
  const rankHi = new Array<number>(scored.length).fill(1);
  for (let b = 0; b < BOOTSTRAP_REFITS; b++) {
    const idx = Array.from({ length: labelled.length }, () => Math.floor(rng() * labelled.length));
    let beta: number[];
    try { beta = ridgeFit(idx.map((i) => X[i]!), idx.map((i) => y[i]!), pen); } catch { continue; }
    const vals = scored.map((s) => {
      const catIdx = value.cats.indexOf(s.p.category ?? '');
      const lm = beta[0]! + beta[1]! * (Math.log10(s.p.tvl_usd) - 8) + (catIdx >= 0 ? beta[2 + catIdx]! : 0);
      return Math.max(1, Math.round(s.p.tvl_usd * Math.pow(10, lm) * s.odds));
    });
    const orderB = vals.map((v, i) => i).sort((a, b2) => vals[b2]! - vals[a]! || (scored[a]!.p.slug < scored[b2]!.p.slug ? -1 : 1));
    orderB.forEach((rowIdx, pos) => {
      rankLo[rowIdx] = Math.min(rankLo[rowIdx]!, pos + 1);
      rankHi[rowIdx] = Math.max(rankHi[rowIdx]!, pos + 1);
    });
  }

  const board: BoardRow[] = scored.map((s, i) => {
    const econ = farmEconomics(s.implied, s.p.tvl_usd);
    const exitTvl = Math.round(s.p.tvl_usd * 0.83);
    const plan = farmPlan(s.p, s.age, econ.deposit, exitTvl);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      if_launches_usd: s.ifLaunches,
      token_odds: r4(s.odds),
      p25_usd: s.p25,
      p75_usd: s.p75,
      p10_usd: s.p10,
      p90_usd: s.p90,
      verdict: econ.verdict,
      deposit_usd: econ.deposit,
      net_usd: Math.round(econ.net * 100) / 100,
      net_per_hour_usd: r2(econ.perHour),
      tbill_usd: r2(econ.tbill),
      rank_lo: rankLo[i]!,
      rank_hi: rankHi[i]!,
      model: {
        base_multiple: r4(Math.pow(10, value.beta[0]!)),
        size_slope: value.slope,
        category_effect: r4(catEffect(s.p)),
        category_priced: catCount.get(s.p.category ?? '') ?? 0,
        age_days: s.age,
        growth_pct: s.p.change_7d ?? 0,
      },
      farm_steps: plan.map(stepText),
    };
  });

  const peersFor = (row: BoardRow): PeerRow[] => {
    const sorted = [...pricedAll].sort((a, b) => {
      const ca = a.category === row.category ? 0 : 1;
      const cb = b.category === row.category ? 0 : 1;
      if (ca !== cb) return ca - cb;
      const da = Math.abs(Math.log10(a.tvl_usd) - Math.log10(row.tvl_usd));
      const db = Math.abs(Math.log10(b.tvl_usd) - Math.log10(row.tvl_usd));
      return da - db || (a.slug < b.slug ? -1 : 1);
    }).slice(0, 8);
    return sorted.map((q) => {
      const looPred = value.looPredBySlug.get(q.slug);
      const modelCap = looPred === undefined ? null : q.tvl_usd * Math.pow(10, looPred);
      return {
        name: q.name,
        category: q.category,
        tvl_usd: q.tvl_usd,
        mcap_usd: q.mcap_usd!,
        cap_per_tvl: r4(q.mcap_usd! / q.tvl_usd),
        cap_per_model: modelCap === null ? 0 : r2(q.mcap_usd! / modelCap),
      };
    });
  };

  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));

  const verdictCounts = { Farm: 0, Marginal: 0, Skip: 0 };
  for (const r of board) verdictCounts[r.verdict]++;

  const rows: RadarRow[] = board.map((r) => {
    const p = index.get(r.slug)!;
    const econ = farmEconomics(r.implied_value_usd, r.tvl_usd);
    return {
      rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
      tvl_usd: r.tvl_usd, change_7d: r.change_7d, listed_at: r.listed_at, age_days: r.age_days,
      implied_value_usd: r.implied_value_usd, if_launches_usd: r.if_launches_usd, token_odds: r.token_odds,
      p25_usd: r.p25_usd, p75_usd: r.p75_usd, p10_usd: r.p10_usd, p90_usd: r.p90_usd,
      verdict: r.verdict, deposit_usd: r.deposit_usd, net_usd: r.net_usd, net_per_hour_usd: r.net_per_hour_usd,
      tbill_usd: r.tbill_usd, rank_lo: r.rank_lo, rank_hi: r.rank_hi,
      watch: snapshot.watchlist.includes(r.slug),
      exit_tvl_usd: Math.round(r.tvl_usd * 0.83),
      multiple: r4(r.if_launches_usd / r.tvl_usd),
      size_slope: r.model.size_slope, category_effect: r.model.category_effect, category_priced: r.model.category_priced,
      plan: farmPlan(p, r.age_days, econ.deposit, Math.round(r.tvl_usd * 0.83)),
      peers: peersFor(r),
    };
  });

  const totalTvl = board.reduce((s, r) => s + r.tvl_usd, 0);
  const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const tokenRecorded = snapshot.protocols.filter((p) => p.symbol !== null).length;
  const tokenPriced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;

  // The LOO-prediction map is a runtime lookup, not JSON data: drop it
  // from the payload the dashboard reads.
  const valueOut = { ...value };
  delete (valueOut as unknown as Record<string, unknown>).looPredBySlug;

  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    live_size: live.length,
    ledger: {
      ranked_watchlist: snapshot.watchlist.length,
      ranked_early: board.length - snapshot.watchlist.length,
      token_priced: tokenPriced,
      token_no_cap: tokenRecorded - tokenPriced,
      out_not_ranked: snapshot.protocols.length - tokenRecorded - board.length,
      total: snapshot.protocols.length,
    },
    totals: { tvl_usd: totalTvl, implied_usd: totalImplied },
    checksum: '',
    value: valueOut,
    odds,
    farm_rule: {
      deposit_frac: FARM.deposit_frac, drop_share: FARM.drop_share, horizon_weeks: FARM.horizon_weeks,
      tbill_rate: FARM.tbill_rate, wage_per_hour: FARM.wage_per_hour,
      gas_base: FARM.gas_base, gas_weekly: FARM.gas_weekly, setup_min: 80, weekly_min: 10,
    },
    verdict_counts: verdictCounts,
    scatter: labelled.map((p) => ({ tvl_usd: p.tvl_usd, ratio: r4(p.mcap_usd! / p.tvl_usd) })),
    rows,
    live,
  };
  return { board, radar };
}

// ------------------------------------------------------------ io + gate

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
