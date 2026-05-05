'use client';

import { useMemo, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

interface Inputs {
  ipBopd: number;
  declineYr1: number;
  bExponent: number;
  oilPriceUsdBbl: number;
  gasPriceUsdMcf: number;
  gor: number;
  royaltyRate: number;
  workingInterest: number;
  opexUsdMonth: number;
  capexUsd: number;
  discountRate: number;
  monthsHorizon: number;
}

const DEFAULTS: Inputs = {
  ipBopd: 950,
  declineYr1: 0.6,
  bExponent: 0.9,
  oilPriceUsdBbl: 72,
  gasPriceUsdMcf: 2.85,
  gor: 2.5,
  royaltyRate: 0.1875,
  workingInterest: 0.75,
  opexUsdMonth: 15000,
  capexUsd: 8500000,
  discountRate: 0.10,
  monthsHorizon: 180,
};

export function NPVCalculator() {
  const [i, setI] = useState<Inputs>(DEFAULTS);
  const result = useMemo(() => compute(i), [i]);

  const set = <K extends keyof Inputs>(key: K, value: number) => setI((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2 rounded-lg border border-border bg-bg-panel p-3 font-mono text-xs">
        <NumField label="IP (bopd)" v={i.ipBopd} onChange={(v) => set('ipBopd', v)} />
        <NumField label="Yr-1 decline" v={i.declineYr1} step={0.05} onChange={(v) => set('declineYr1', v)} />
        <NumField label="b exponent" v={i.bExponent} step={0.05} onChange={(v) => set('bExponent', v)} />
        <NumField label="Oil $/bbl" v={i.oilPriceUsdBbl} onChange={(v) => set('oilPriceUsdBbl', v)} />
        <NumField label="Gas $/mcf" v={i.gasPriceUsdMcf} step={0.05} onChange={(v) => set('gasPriceUsdMcf', v)} />
        <NumField label="GOR (mcf/bbl)" v={i.gor} step={0.1} onChange={(v) => set('gor', v)} />
        <NumField label="Royalty" v={i.royaltyRate} step={0.005} onChange={(v) => set('royaltyRate', v)} />
        <NumField label="WI" v={i.workingInterest} step={0.05} onChange={(v) => set('workingInterest', v)} />
        <NumField label="Opex $/mo" v={i.opexUsdMonth} onChange={(v) => set('opexUsdMonth', v)} />
        <NumField label="Capex $" v={i.capexUsd} onChange={(v) => set('capexUsd', v)} />
        <NumField label="Discount" v={i.discountRate} step={0.01} onChange={(v) => set('discountRate', v)} />
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="NPV (USD)" value={fmtUsd(result.npv)} accent />
          <Stat label="Undisc. return" value={fmtUsd(result.undiscounted)} />
          <Stat label="Payout" value={result.payoutMonth ? `${result.payoutMonth} mo` : '—'} />
        </div>
        <div className="rounded-lg border border-border bg-bg-panel p-2">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={result.monthly}>
              <CartesianGrid stroke="#1e2430" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#64748b' }} stroke="#1e2430" />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} stroke="#1e2430" width={56} />
              <Tooltip
                contentStyle={{ backgroundColor: '#161a22', border: '1px solid #1e2430', fontSize: 11 }}
                labelStyle={{ color: '#e2e8f0' }}
                itemStyle={{ color: '#e2e8f0' }}
              />
              <Area type="monotone" dataKey="netCashUsd" stroke="#10b981" fill="#10b98130" name="Net cash" />
              <Area type="monotone" dataKey="discountedNetUsd" stroke="#f59e0b" fill="#f59e0b30" name="Discounted" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function NumField({ label, v, step = 1, onChange }: { label: string; v: number; step?: number; onChange: (n: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-text-subtle">{label}</span>
      <input
        type="number"
        step={step}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 rounded border border-border bg-bg px-2 py-1 text-right text-text focus:border-accent focus:outline-none"
      />
    </label>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-bg-panel px-3 py-2">
      <div className="font-mono text-[10px] uppercase text-text-muted">{label}</div>
      <div className={`data-value text-lg ${accent ? 'text-accent' : 'text-text'}`}>{value}</div>
    </div>
  );
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function compute(i: Inputs) {
  const monthly: Array<{ month: number; oilBbl: number; gasMcf: number; revenueUsd: number; netCashUsd: number; discountedNetUsd: number }> = [];
  let cumulativeNet = 0;
  let cumulativeDisc = -i.capexUsd;
  let payoutMonth: number | null = null;
  let runningNet = 0;

  for (let m = 0; m < i.monthsHorizon; m++) {
    const t = m / 12;
    const factor = Math.pow(1 + i.bExponent * i.declineYr1 * t, -1 / i.bExponent);
    const oilBbl = (i.ipBopd * 30.4) * factor;
    const gasMcf = oilBbl * i.gor;
    const grossRev = oilBbl * i.oilPriceUsdBbl + gasMcf * i.gasPriceUsdMcf;
    const royalty = grossRev * i.royaltyRate;
    const workShare = (grossRev - royalty) * i.workingInterest;
    const netCash = workShare - i.opexUsdMonth;
    const disc = netCash / Math.pow(1 + i.discountRate, m / 12);
    cumulativeNet += netCash;
    cumulativeDisc += disc;
    runningNet += netCash;
    if (payoutMonth === null && runningNet >= i.capexUsd) payoutMonth = m;

    monthly.push({
      month: m,
      oilBbl: Math.round(oilBbl),
      gasMcf: Math.round(gasMcf),
      revenueUsd: Math.round(grossRev),
      netCashUsd: Math.round(netCash),
      discountedNetUsd: Math.round(disc),
    });
  }

  return { npv: Math.round(cumulativeDisc), undiscounted: Math.round(cumulativeNet - i.capexUsd), payoutMonth, monthly };
}
