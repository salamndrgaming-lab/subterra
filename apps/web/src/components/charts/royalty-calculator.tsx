'use client';

import { useMemo, useState } from 'react';

export function RoyaltyCalculator() {
  const [grossOilBbl, setGrossOilBbl] = useState(50000);
  const [grossGasMcf, setGrossGasMcf] = useState(120000);
  const [oilPrice, setOilPrice] = useState(72);
  const [gasPrice, setGasPrice] = useState(2.85);
  const [royaltyRate, setRoyaltyRate] = useState(0.1875);

  const out = useMemo(() => {
    const oilRevenue = grossOilBbl * oilPrice;
    const gasRevenue = grossGasMcf * gasPrice;
    const grossRevenue = oilRevenue + gasRevenue;
    const royalty = grossRevenue * royaltyRate;
    return { oilRevenue, gasRevenue, grossRevenue, royalty };
  }, [grossOilBbl, grossGasMcf, oilPrice, gasPrice, royaltyRate]);

  return (
    <div className="rounded-lg border border-border bg-bg-panel p-4 font-mono text-xs">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Oil produced (bbl)" value={grossOilBbl} onChange={setGrossOilBbl} />
        <Field label="Gas produced (mcf)" value={grossGasMcf} onChange={setGrossGasMcf} />
        <Field label="Oil price ($/bbl)" value={oilPrice} onChange={setOilPrice} step={0.5} />
        <Field label="Gas price ($/mcf)" value={gasPrice} onChange={setGasPrice} step={0.05} />
        <Field label="Royalty rate" value={royaltyRate} onChange={setRoyaltyRate} step={0.005} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
        <Result label="Gross revenue" value={`$${Math.round(out.grossRevenue).toLocaleString()}`} />
        <Result label="Royalty" value={`$${Math.round(out.royalty).toLocaleString()}`} accent />
      </div>
    </div>
  );
}

function Field({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded border border-border bg-bg px-2 py-1 text-text focus:border-accent focus:outline-none"
      />
    </label>
  );
}

function Result({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <div className={`data-value text-lg ${accent ? 'text-accent' : 'text-text'}`}>{value}</div>
    </div>
  );
}
