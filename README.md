# Launch Odds Radar v14-mellow

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v14-mellow/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v14-mellow/reward.svg)](https://make.fun/bounty/token-radar-01)

A pre-token launch radar for the make.fun `token-radar-01` bounty, built
under `@mellow-robin-54`. It ranks 198 pre-token protocols by implied value
and gives each one a costed 10-step farm plan.

## Model (radar-14, fitted at run time from the snapshot alone)

- **Value:** ridge on log10(TVL) plus shrunk category effects (ridge 16,
  chosen by a shrinkage sweep). Typical miss: leave-one-out ×4.24,
  walk-forward (66 oldest train / 29 newest test) ×5.39, 5-fold ×4.56 —
  against a flat-median baseline of ×5.31 / ×7.21. Multiple at $100M TVL
  ×0.16, size slope −0.55 ± 0.10.
- **Token odds:** logistic on age, family and size, fitted on the 645 dated
  protocols (327 record a token). Brier 0.215 ten-fold / 0.270
  walk-forward against a 0.287 base rate; AUC 0.724 / 0.591.
- **Term rule:** a term enters only if it lowers the held-out miss on both
  leave-one-out and walk-forward, mean and median. Family, 7-day growth,
  age and chain count were tested and not kept; the tables are on the
  dashboard, with a control row that must not help.
- **Farm rule (strict):** a row is Farm only if its modelled net beats a 4%
  T-bill on the same deposit **and** $25 an hour, over 12 weeks at a 7%
  drop share, deposit 0.02% of TVL, $15.00 of gas. Result: 4 Farm,
  185 Marginal, 9 Skip. The top-implied giants are Marginal — that is the
  point.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22 or later, standard library only. Two runs write the same bytes.
The dashboard is `dashboard/` (static, no network) with its data in
`data.js`; screenshots are in `screenshots/`.
