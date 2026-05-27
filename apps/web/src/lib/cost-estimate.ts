/**
 * Mining-claim acquisition + operation cost estimates.
 *
 * Numbers below are 2025 BLM fees and industry-standard exploration /
 * operation ranges. Sources cited inline. These are ESTIMATES — actual
 * costs vary by state, surface management agency, and commodity. The
 * cost panel in the detail drawer always shows the source/disclaimer.
 *
 * BLM fees per 43 CFR 3833 and updated maintenance fee schedule:
 *   https://www.blm.gov/programs/energy-and-minerals/mining-and-minerals/
 *     locatable-minerals/mining-claims/fees
 */

export type StakeContext =
  /** On BLM/USFS surface, no overlapping claim — open ground. */
  | 'open'
  /** Overlapping active mining claim. */
  | 'covered'
  /** Active claim was the clicked feature itself. */
  | 'self-claim';

export interface LineItem {
  label: string;
  /** Exact dollar amount, OR low–high range. */
  amount: number | [number, number];
  /** Short context (where the fee comes from, what unlocks it). */
  note?: string;
}

export interface CostEstimate {
  context: StakeContext;
  /** Concise one-liner shown at top of the cost panel. */
  headline: string;
  /** Year-one acquisition line items. */
  acquisition: LineItem[];
  /** Recurring annual cost line items (each is "/yr"). */
  annual: LineItem[];
  /** Optional exploration spend if user wants to verify the deposit. */
  exploration: LineItem[];
  /** Optional production-phase costs (only relevant if proving up). */
  production: LineItem[];
  /** Free-form notes (commodity-specific tips, caveats). */
  notes: string[];
}

/** Formatted dollar string for a LineItem.amount. */
export function formatAmount(amt: number | [number, number]): string {
  if (Array.isArray(amt)) {
    return `${formatUSD(amt[0])}–${formatUSD(amt[1])}`;
  }
  return formatUSD(amt);
}

function formatUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${n}`;
}

/** Sum the low side of every line-item amount. */
function sumLow(items: LineItem[]): number {
  return items.reduce(
    (acc, it) => acc + (Array.isArray(it.amount) ? it.amount[0] : it.amount),
    0,
  );
}

function sumHigh(items: LineItem[]): number {
  return items.reduce(
    (acc, it) => acc + (Array.isArray(it.amount) ? it.amount[1] : it.amount),
    0,
  );
}

export function totalRange(items: LineItem[]): string {
  const low = sumLow(items);
  const high = sumHigh(items);
  if (low === high) return formatUSD(low);
  return `${formatUSD(low)}–${formatUSD(high)}`;
}

interface EstimateInput {
  overlapCount: number;
  isMiningClaim: boolean;
  commodity?: string; // from clicked feature, if MRDS
}

export function estimateCosts(input: EstimateInput): CostEstimate {
  const context: StakeContext =
    input.isMiningClaim ? 'self-claim'
      : input.overlapCount > 0 ? 'covered'
        : 'open';

  if (context === 'covered') {
    return {
      context,
      headline:
        input.overlapCount === 1
          ? 'Ground is covered by an active claim — would need to acquire from the existing claimant or wait for it to lapse.'
          : `Ground is covered by ${input.overlapCount} active claims — acquisition would require buying out multiple claimants.`,
      acquisition: [
        {
          label: 'Claim purchase (per claim)',
          amount: [500, 50_000],
          note: 'Highly variable: from quitclaim transfer (~$500) to negotiated buyout near producing ground (>$50k).',
        },
        {
          label: 'County recording — transfer',
          amount: [15, 50],
          note: 'Per claim, varies by county.',
        },
      ],
      annual: [
        {
          label: 'BLM maintenance fee per claim',
          amount: 165,
          note: '$165/yr per 20-acre lode or 160-acre placer. Due Sept 1 yearly.',
        },
      ],
      exploration: [],
      production: [],
      notes: [
        'Claim status can be verified by serial number through LR2000.',
        'If a claim is delinquent on annual maintenance fees, it forfeits — those become open ground 90 days after Sept 1.',
      ],
    };
  }

  if (context === 'self-claim') {
    return {
      context,
      headline: 'Existing active mining claim — these are the recurring costs to hold it.',
      acquisition: [],
      annual: [
        {
          label: 'BLM maintenance fee',
          amount: 165,
          note: '$165/yr per claim (small-miner waiver available if <10 claims total, requires $100/yr of assessment work).',
        },
        {
          label: 'County recording — annual affidavit',
          amount: [15, 50],
        },
      ],
      exploration: explorationCosts(input.commodity),
      production: productionCosts(),
      notes: claimNotes(input.commodity),
    };
  }

  // OPEN — primary stakeable workflow.
  return {
    context,
    headline:
      'No overlapping active claim. Subject to surface management agency rules and any withdrawal status, this point is open to mineral location under the 1872 Mining Law.',
    acquisition: [
      {
        label: 'BLM location fee',
        amount: 40,
        note: 'Per claim, paid once at filing (43 CFR 3833).',
      },
      {
        label: 'BLM initial processing fee',
        amount: 20,
        note: 'Per claim, paid once at filing.',
      },
      {
        label: 'County recording',
        amount: [15, 50],
        note: 'Notice of Location must be recorded with the county within 90 days of discovery.',
      },
      {
        label: 'Monuments + corner posts',
        amount: [50, 200],
        note: 'Per claim. Each of 4 corners + discovery monument needs a durable marker.',
      },
      {
        label: 'GPS gear + field labor',
        amount: [100, 500],
        note: 'Travel, time, fuel to set monuments and record GPS corners.',
      },
    ],
    annual: [
      {
        label: 'BLM maintenance fee per claim',
        amount: 165,
        note: '$165/yr per 20-acre lode or 160-acre placer. Due Sept 1 yearly. Failure to pay = forfeiture.',
      },
      {
        label: 'Small-miner waiver (alternative)',
        amount: 10,
        note: '$10 filing + $100 in documented assessment work in lieu of $165 fee. Only if <10 claims total.',
      },
    ],
    exploration: explorationCosts(input.commodity),
    production: productionCosts(),
    notes: claimNotes(input.commodity),
  };
}

function explorationCosts(_commodity?: string): LineItem[] {
  return [
    {
      label: 'Surface sampling + assays',
      amount: [500, 5_000],
      note: '5–50 samples sent to a fire-assay lab (~$25–50 per sample for Au/Ag).',
    },
    {
      label: 'Notice of Intent (NOI), <5 acres disturbance',
      amount: [1_000, 5_000],
      note: 'BLM permit for exploration disturbance ≤5 acres. Required before mechanized work.',
    },
    {
      label: 'Reverse-circulation drilling, per hole',
      amount: [5_000, 20_000],
      note: 'Typical 200–500 ft RC hole. Diamond core drilling is 3–5× more expensive.',
    },
  ];
}

function productionCosts(): LineItem[] {
  return [
    {
      label: 'Plan of Operations (POO), >5 acres',
      amount: [10_000, 100_000],
      note: 'Required for any mechanized mining ≥5 acres. Includes EA/EIS prep + agency review.',
    },
    {
      label: 'Reclamation bond',
      amount: [5_000, 100_000],
      note: 'Posted with BLM and state. ~$1k–$5k per acre disturbed depending on terrain.',
    },
    {
      label: 'Equipment + setup',
      amount: [50_000, 1_000_000],
      note: 'Varies wildly: hand tools + sluice for placer, full mill + tailings facility for hard-rock.',
    },
  ];
}

function claimNotes(commodity?: string): string[] {
  const c = (commodity ?? '').toLowerCase();
  const notes: string[] = [
    'Lode claim: 20 acres max (1500×600 ft). Placer claim: up to 20 acres per individual, 160 acres associated.',
    'Surface management agency (BLM vs USFS) determines permitting path. National parks + most tribal land are NOT open to location.',
  ];
  if (c.includes('gold') || c.includes('silver')) {
    notes.push('Precious-metal lode claims usually require diamond core drilling to verify continuity — budget $50–150/ft.');
  }
  if (c.includes('lithium') || c.includes('rare earth') || c.includes('cobalt') || c.includes('nickel')) {
    notes.push('Critical-mineral deposits may qualify for DOE / DPA Title III grant funding to offset exploration costs.');
  }
  if (c.includes('uranium')) {
    notes.push('Uranium subject to additional NRC + state licensing on top of standard BLM permits.');
  }
  if (c.includes('sand') || c.includes('gravel') || c.includes('common var')) {
    notes.push('Sand/gravel are "common varieties" — generally NOT locatable; sold via BLM mineral materials sales instead.');
  }
  return notes;
}
