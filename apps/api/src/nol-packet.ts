/**
 * Staking-packet PDF generator.
 *
 * Turns a saved AOI + the prospector's inputs into a printable
 * "staking preparation packet" — the location facts, corner
 * coordinates, a claims-to-stake + cost estimate, a commodity summary,
 * and a BLM Notice-of-Location filing checklist. It's a preparation aid
 * (the $25/filing Prospector feature), NOT legal advice or a filed
 * document — the packet carries a clear review-before-filing disclaimer.
 *
 * pdf-lib is pure JS (no native deps) so it runs in the Cloudflare Worker
 * with nodejs_compat. Generation is deterministic given the inputs, so it
 * unit-tests by asserting a valid %PDF byte stream.
 */

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';

export interface StakingPacketInput {
  aoiName: string;
  acres: number;
  /** AOI polygon ring as [lng, lat] pairs (the corners to monument). */
  corners: Array<[number, number]>;
  centroid: [number, number];
  /** Prospector-provided, all optional — blanks render as fill-in lines. */
  claimantName?: string;
  claimantAddress?: string;
  claimType?: 'lode' | 'placer' | 'millsite';
  claimName?: string;
  /** Rough staking economics (from the AOI cost model). */
  lodeClaims?: number;
  year1CostLow?: number;
  year1CostHigh?: number;
  annualCost?: number;
  /** "AU:12, AG:7" style summary of occurrences inside the AOI. */
  commoditySummary?: string;
}

const MARGIN = 54;
const INK = rgb(0.09, 0.11, 0.13);
const MUTED = rgb(0.42, 0.46, 0.52);
const ACCENT = rgb(0.86, 0.55, 0.05);
const RULE = rgb(0.8, 0.82, 0.85);

export async function buildStakingPacketPdf(input: StakingPacketInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Subterra Staking Packet — ${input.aoiName}`);
  doc.setProducer('Subterra');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([612, 792]); // US Letter
  let y = 792 - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([612, 792]);
      y = 792 - MARGIN;
    }
  };
  const text = (s: string, opts: { x?: number; size?: number; f?: PDFFont; color?: typeof INK } = {}) => {
    page.drawText(s, {
      x: opts.x ?? MARGIN,
      y,
      size: opts.size ?? 10,
      font: opts.f ?? font,
      color: opts.color ?? INK,
    });
  };
  const line = (gap = 14) => {
    y -= gap;
  };
  const rule = () => {
    ensureSpace(10);
    page.drawLine({
      start: { x: MARGIN, y: y - 2 },
      end: { x: 612 - MARGIN, y: y - 2 },
      thickness: 0.5,
      color: RULE,
    });
    line(12);
  };
  const heading = (s: string) => {
    ensureSpace(24);
    line(6);
    text(s, { size: 12, f: bold, color: ACCENT });
    line(6);
    rule();
  };
  const field = (label: string, value: string | undefined) => {
    ensureSpace(16);
    text(label, { size: 9, f: bold, color: MUTED });
    text(value && value.trim() ? value : '__________________________', { x: 190, size: 10 });
    line(16);
  };

  // Header
  text('SUBTERRA', { size: 9, f: bold, color: MUTED });
  line(18);
  text('Mining-Claim Staking Packet', { size: 18, f: bold });
  line(16);
  text(input.aoiName, { size: 11, color: MUTED });
  line(20);

  // Location
  heading('Location');
  field('Centroid (lng, lat)', `${input.centroid[0].toFixed(6)}, ${input.centroid[1].toFixed(6)}`);
  field('Area', `${input.acres.toLocaleString(undefined, { maximumFractionDigits: 1 })} acres`);
  field('Township / Range / Sec', undefined); // filled from PLSS at the recorder
  line(4);

  // Corner monuments
  heading('Corner monuments to set');
  text('Set a monument at each corner and record its coordinates.', { size: 9, color: MUTED });
  line(16);
  input.corners.slice(0, 12).forEach((c, i) => {
    ensureSpace(14);
    text(`Corner ${i + 1}`, { size: 9, f: bold, color: MUTED });
    text(`${c[0].toFixed(6)}, ${c[1].toFixed(6)}`, { x: 130, size: 10 });
    line(14);
  });
  line(4);

  // Claimant
  heading('Claimant & claim');
  field('Claimant name', input.claimantName);
  field('Mailing address', input.claimantAddress);
  field('Claim type', input.claimType);
  field('Claim name', input.claimName);
  line(4);

  // Economics
  heading('Staking economics (estimate)');
  if (input.lodeClaims) field('20-acre lode claims needed', String(input.lodeClaims));
  if (input.year1CostLow != null && input.year1CostHigh != null) {
    field(
      'Year-1 acquisition',
      `$${input.year1CostLow.toLocaleString()}–$${input.year1CostHigh.toLocaleString()}`,
    );
  }
  if (input.annualCost != null) field('Annual maintenance', `$${input.annualCost.toLocaleString()}/yr`);
  if (input.commoditySummary) field('Occurrences inside', input.commoditySummary);
  line(4);

  // Checklist
  heading('BLM Notice-of-Location filing checklist');
  const steps = [
    'Confirm the ground is open (not withdrawn, not on tribal/critical-habitat land).',
    'Physically monument each corner + post a location notice on the claim.',
    'Complete a Notice/Certificate of Location for your state.',
    'Record it with the county recorder in the county where the claim lies.',
    'File a copy with the BLM state office within 90 days of location.',
    'Pay the BLM initial maintenance fee (or file a small-miner waiver).',
  ];
  steps.forEach((s) => {
    ensureSpace(16);
    page.drawRectangle({ x: MARGIN, y: y - 1, width: 9, height: 9, borderColor: MUTED, borderWidth: 0.75 });
    text(s, { x: MARGIN + 16, size: 9 });
    line(16);
  });

  // Disclaimer
  line(8);
  rule();
  drawWrapped(
    page,
    font,
    'This packet is a preparation aid generated from public data and your inputs. It is not legal advice and is not a filed document. Mining-claim location + recording requirements vary by state and county — verify current requirements with the BLM state office and county recorder before filing. Township/Range/Section and a formal legal description should be confirmed against the official PLSS survey at the recorder.',
    MARGIN,
    y,
    612 - 2 * MARGIN,
    7.5,
    MUTED,
  );

  return doc.save();
}

/** Minimal word-wrap for the disclaimer paragraph. */
function drawWrapped(
  page: PDFPage,
  font: PDFFont,
  s: string,
  x: number,
  yStart: number,
  maxWidth: number,
  size: number,
  color: typeof INK,
): void {
  const words = s.split(' ');
  let liney = yStart;
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
      page.drawText(cur, { x, y: liney, size, font, color });
      liney -= size + 2;
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) page.drawText(cur, { x, y: liney, size, font, color });
}
