// Token radar, scenario sensitivity: what the ranked board is worth when the market reprices it.
//
// The board's implied values lean on one number per category, the peer multiple. This module
// re-prices the finished board under three other markets instead of trusting a single one: a
// cold market where every multiple halves, a hot market where every multiple doubles up to the
// model's own ceiling, and a flat market where seven-day growth is ignored entirely. It also
// measures how much of a category's value rides on its biggest rows, and scores every
// protocol's launch readiness from its size, its age and its recent growth. Nothing here
// changes the board: it reads the ranked rows the model already produced and reports what
// they would be worth in each case, so the dashboard can show the range beside the single
// number the board carries.
//
// Every figure below is a pure function of the board's own rows. The same snapshot always
// gives the same scenarios, and no protocol name is ever special-cased: the same arithmetic
// scores every row, and the categories are whatever the snapshot's rows carry.

import type { BoardRow } from './model.ts';

/** One row's implied value under each market the module prices. */
export interface ScenarioValues {
  /** The multiple halved: a cold market reprices every launch down. */
  bear: number;
  /** The board's own number, unchanged. */
  base: number;
  /** The multiple doubled, up to the model's ceiling: a hot market. */
  bull: number;
  /** Growth ignored: the value if the last seven days had been flat. */
  flat: number;
}

/** One category's totals under each market, and the row that carries it. */
export interface CategoryScenario {
  category: string;
  rows: number;
  bear: number;
  base: number;
  bull: number;
  flat: number;
  /** The slug of the category's biggest row by base value. */
  topSlug: string;
  /** The name of the category's biggest row by base value. */
  topName: string;
  /** The biggest row's base value. */
  topBase: number;
  /** The biggest row's share of the category's base total, 0..1. */
  topShare: number;
}

/** How much of the whole board rides on its biggest rows. */
export interface Concentration {
  /** The board's base total, the denominator every share below divides by. */
  total: number;
  /** The share of the total the three biggest rows hold, 0..1. */
  topThreeShare: number;
  /** The Herfindahl index over the rows' shares, 0..1: 1 means one row is the board. */
  herfindahl: number;
  /** The slug of the board's biggest row. */
  biggestSlug: string;
  /** The name of the board's biggest row. */
  biggestName: string;
  /** The biggest row's share of the total, 0..1. */
  biggestShare: number;
}

/** One row's range across the markets: how far its value swings from cold to hot. */
export interface SensitivityRange {
  slug: string;
  name: string;
  bear: number;
  base: number;
  bull: number;
  /** Bull minus bear: the dollars the market's mood moves this row by. */
  spread: number;
}

/** One swing band: the rows whose value moves by a similar share across the markets. */
export interface SwingBand {
  /** 'stable' under a quarter's swing, 'moderate' under a doubling, 'volatile' above it. */
  band: 'stable' | 'moderate' | 'volatile';
  /** How many rows fall in the band. */
  rows: number;
  /** The band's base total. */
  base: number;
  /** The band's cold-market total. */
  bear: number;
  /** The band's hot-market total. */
  bull: number;
  /** The band's share of the board's base total, 0..1. */
  share: number;
}

/** One protocol's launch readiness: a score out of 100 and the band it falls in. */
export interface ReadinessEntry {
  slug: string;
  name: string;
  /** 0..100: size, age and growth added up (see readinessScore). */
  score: number;
  /** 'ready' at 80 and above, 'warming' at 60 and above, 'early' below that. */
  band: 'ready' | 'warming' | 'early';
  /** The row's base implied value, for sorting ties. */
  implied: number;
}

/** Everything the dashboard's sensitivity section renders. */
export interface SensitivitySummary {
  /** The board's totals under each market. */
  totals: ScenarioValues;
  /** One entry per category, strongest base total first. */
  categories: CategoryScenario[];
  /** How concentrated the board is. */
  concentration: Concentration;
  /** The ten most ready protocols, best score first. */
  readiness: ReadinessEntry[];
  /** The ten rows whose value swings furthest from a cold market to a hot one. */
  mostSensitive: SensitivityRange[];
  /** The ten rows whose value leans hardest on the last seven days' growth. */
  growthExposed: SensitivityRange[];
  /** The board split into stable, moderate and volatile rows by their cold-to-hot swing. */
  bands: SwingBand[];
}

/** The cold market's factor and the hot market's factor, applied to the peer multiple. */
export const SCENARIO_FACTORS = { bear: 0.5, bull: 2 } as const;

/** The multiple's floor and ceiling, the same bounds the model itself applies. */
export const MULTIPLE_BOUNDS = { floor: 0.05, cap: 1.0 } as const;

/** A number held inside a closed interval. */
function clampTo(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/** One row repriced with its multiple scaled and, optionally, its growth ignored. */
export function repricedValue(row: BoardRow, factor: number, ignoreGrowth: boolean): number {
  const scaled = clampTo(row.model.category_multiple * factor, MULTIPLE_BOUNDS.floor, MULTIPLE_BOUNDS.cap);
  const growth = ignoreGrowth ? 1 : row.model.growth_multiplier;
  const priced = row.tvl_usd * scaled * growth * row.model.maturity_multiplier;
  return Math.max(1, Math.round(priced));
}

/** One row under every market: bear, base, bull and flat. */
export function rowScenarios(row: BoardRow): ScenarioValues {
  return {
    bear: repricedValue(row, SCENARIO_FACTORS.bear, false),
    base: row.implied_value_usd,
    bull: repricedValue(row, SCENARIO_FACTORS.bull, false),
    flat: repricedValue(row, 1, true),
  };
}

/** The label a category gets when it is missing: the rows still count, under one name. */
function categoryLabel(row: BoardRow): string {
  return row.category ?? 'Other';
}

/**
 * Every category's totals under each market. The categories come out strongest first by
 * base total, and each one names the row that carries it, so a reader can see at a glance
 * whether a category's value is one protocol or a whole bench.
 */
export function categoryScenarios(board: BoardRow[]): CategoryScenario[] {
  const grouped = new Map<string, BoardRow[]>();
  for (const row of board) {
    const key = categoryLabel(row);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  const out: CategoryScenario[] = [];
  for (const [category, rows] of grouped) {
    let bear = 0;
    let base = 0;
    let bull = 0;
    let flat = 0;
    let top = rows[0]!;
    for (const row of rows) {
      const priced = rowScenarios(row);
      bear += priced.bear;
      base += priced.base;
      bull += priced.bull;
      flat += priced.flat;
      if (row.implied_value_usd > top.implied_value_usd) top = row;
    }
    out.push({
      category,
      rows: rows.length,
      bear,
      base,
      bull,
      flat,
      topSlug: top.slug,
      topName: top.name,
      topBase: top.implied_value_usd,
      topShare: base > 0 ? top.implied_value_usd / base : 0,
    });
  }
  out.sort((a, b) => b.base - a.base || (a.category < b.category ? -1 : 1));
  return out;
}

/**
 * How concentrated the board is: the share its three biggest rows hold, the Herfindahl
 * index over every row's share, and the single biggest row. A board whose value sits in
 * one or two rows is a bet on those launches; a spread board is a bet on the category.
 */
export function concentrationOf(board: BoardRow[]): Concentration {
  const total = board.reduce((sum, row) => sum + row.implied_value_usd, 0);
  if (board.length === 0 || total <= 0) {
    return { total: 0, topThreeShare: 0, herfindahl: 0, biggestSlug: '', biggestName: '', biggestShare: 0 };
  }
  const ranked = [...board].sort((a, b) => b.implied_value_usd - a.implied_value_usd);
  const topThree = ranked.slice(0, 3).reduce((sum, row) => sum + row.implied_value_usd, 0);
  let herfindahl = 0;
  for (const row of board) {
    const share = row.implied_value_usd / total;
    herfindahl += share * share;
  }
  const biggest = ranked[0]!;
  return {
    total,
    topThreeShare: topThree / total,
    herfindahl,
    biggestSlug: biggest.slug,
    biggestName: biggest.name,
    biggestShare: biggest.implied_value_usd / total,
  };
}

/**
 * One protocol's launch readiness, 0..100. Size is worth 40: a protocol with a billion
 * dollars of TVL has something to launch, one with ten million has a long way to go. Age
 * is worth 30: a year with no token is a launch waiting to happen, a month is barely
 * started. Recent growth is worth 30: a rising protocol is readier than a shrinking one.
 * The bands are blunt on purpose: readiness is a sorting aid, not a prediction.
 */
export function readinessScore(row: BoardRow): number {
  let size = 10;
  if (row.tvl_usd >= 1_000_000_000) size = 40;
  else if (row.tvl_usd >= 100_000_000) size = 30;
  else if (row.tvl_usd >= 10_000_000) size = 20;
  const age = row.age_days ?? 365;
  let agePoints = 6;
  if (age >= 365) agePoints = 30;
  else if (age >= 180) agePoints = 22;
  else if (age >= 90) agePoints = 14;
  const growth = row.change_7d ?? 0;
  let growthPoints = 10;
  if (growth >= 0) growthPoints = 30;
  else if (growth >= -20) growthPoints = 20;
  return size + agePoints + growthPoints;
}

/** The band a readiness score falls in. */
export function readinessBand(score: number): ReadinessEntry['band'] {
  if (score >= 80) return 'ready';
  if (score >= 60) return 'warming';
  return 'early';
}

/** The ten most ready protocols, best score first, ties broken by implied value. */
export function readinessList(board: BoardRow[]): ReadinessEntry[] {
  const scored = board.map((row) => {
    const score = readinessScore(row);
    return {
      slug: row.slug,
      name: row.name,
      score,
      band: readinessBand(score),
      implied: row.implied_value_usd,
    };
  });
  scored.sort((a, b) => b.score - a.score || b.implied - a.implied || (a.slug < b.slug ? -1 : 1));
  return scored.slice(0, 10);
}

/**
 * The rows whose value swings furthest between a cold and a hot market. A wide spread
 * means the row's worth is mostly the market's mood, not the protocol's own record: the
 * multiple does the work, so a repricing moves it more than its neighbours.
 */
export function mostSensitiveRows(board: BoardRow[], count = 10): SensitivityRange[] {
  const ranged = board.map((row) => {
    const priced = rowScenarios(row);
    return {
      slug: row.slug,
      name: row.name,
      bear: priced.bear,
      base: priced.base,
      bull: priced.bull,
      spread: priced.bull - priced.bear,
    };
  });
  ranged.sort((a, b) => b.spread - a.spread || b.base - a.base || (a.slug < b.slug ? -1 : 1));
  return ranged.slice(0, count);
}

/**
 * The rows whose value leans hardest on the last seven days. The spread here is the
 * distance between the board's number and the flat-growth number: a row far above its
 * flat value is riding a hot week, and a row below it is being held back by one.
 */
export function growthExposedRows(board: BoardRow[], count = 10): SensitivityRange[] {
  const ranged = board.map((row) => {
    const priced = rowScenarios(row);
    const gap = Math.abs(priced.base - priced.flat);
    return {
      slug: row.slug,
      name: row.name,
      bear: priced.bear,
      base: priced.base,
      bull: priced.bull,
      spread: gap,
    };
  });
  ranged.sort((a, b) => b.spread - a.spread || b.base - a.base || (a.slug < b.slug ? -1 : 1));
  return ranged.slice(0, count);
}

/**
 * The band a row's cold-to-hot swing puts it in. The swing is measured against the
 * row's own base value, so a small row and a big row are judged on the same scale: a
 * row that doubles or more when the market turns hot is volatile whatever its size,
 * and one that barely moves is stable whatever its size.
 */
export function swingBandOf(row: BoardRow): SwingBand['band'] {
  const priced = rowScenarios(row);
  if (priced.base <= 0) return 'stable';
  const swing = (priced.bull - priced.bear) / priced.base;
  if (swing < 0.25) return 'stable';
  if (swing <= 1) return 'moderate';
  return 'volatile';
}

/**
 * The board split into swing bands. Each band carries its rows, its base total and
 * its cold and hot totals, so the dashboard can say how much of the board is steady
 * money and how much is a bet on the market staying generous.
 */
export function swingBands(board: BoardRow[]): SwingBand[] {
  const totals: ScenarioValues = { bear: 0, base: 0, bull: 0, flat: 0 };
  for (const row of board) {
    const priced = rowScenarios(row);
    totals.bear += priced.bear;
    totals.base += priced.base;
    totals.bull += priced.bull;
    totals.flat += priced.flat;
  }
  const bands: SwingBand[] = [];
  for (const band of ['stable', 'moderate', 'volatile'] as const) {
    let rows = 0;
    let bear = 0;
    let base = 0;
    let bull = 0;
    for (const row of board) {
      if (swingBandOf(row) !== band) continue;
      const priced = rowScenarios(row);
      rows += 1;
      bear += priced.bear;
      base += priced.base;
      bull += priced.bull;
    }
    bands.push({
      band,
      rows,
      base,
      bear,
      bull,
      share: totals.base > 0 ? base / totals.base : 0,
    });
  }
  return bands;
}

/** The whole sensitivity summary for a board: totals, categories, concentration, readiness. */
export function buildSensitivity(board: BoardRow[]): SensitivitySummary {
  const totals: ScenarioValues = { bear: 0, base: 0, bull: 0, flat: 0 };
  for (const row of board) {
    const priced = rowScenarios(row);
    totals.bear += priced.bear;
    totals.base += priced.base;
    totals.bull += priced.bull;
    totals.flat += priced.flat;
  }
  return {
    totals,
    categories: categoryScenarios(board),
    concentration: concentrationOf(board),
    readiness: readinessList(board),
    mostSensitive: mostSensitiveRows(board),
    growthExposed: growthExposedRows(board),
    bands: swingBands(board),
  };
}
