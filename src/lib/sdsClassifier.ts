// Heuristic classifier for items that likely require an SDS (Safety Data Sheet)
// during Walmart Seller Center → WFS conversion.
//
// Walmart requires SDS for products containing potentially hazardous chemicals,
// aerosols, pesticides, or batteries. This is a name-based heuristic — it errs
// on the side of flagging items as "Likely" so sellers can prepare an SDS URL
// before submitting for WFS conversion. Final determination is Walmart's.

export type SdsRequirement = "Likely required" | "Possibly required" | "Not required";

export interface SdsClassification {
  requirement: SdsRequirement;
  reasons: string[]; // human-readable keywords that triggered the match
}

// Strong signals — almost certainly require an SDS.
const STRONG_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\baerosol|spray\s*(can|paint|adhesive|lubricant|cleaner|repellent|sunscreen|deodorant)\b/i, label: "aerosol" },
  { re: /\b(lithium|li-?ion|li-?po|lipo|alkaline|nimh|ni-?cd|lead[-\s]?acid)\b/i, label: "battery chemistry" },
  { re: /\b(battery|batteries|battery[-\s]?pack|power[-\s]?bank|powerbank)\b/i, label: "battery" },
  { re: /\b(pesticid|insecticid|herbicid|fungicid|rodenticid|miticid|repellent|weed\s*killer|bug\s*spray|ant\s*killer|roach\s*killer)\w*/i, label: "pesticide" },
  { re: /\b(bleach|ammonia|acetone|toluene|xylene|methanol|ethanol\s+\d|formaldehyde|hydrochloric|sulfuric|nitric|sodium\s+hydroxide|lye|muriatic)\b/i, label: "hazardous chemical" },
  { re: /\b(propane|butane|isobutane|kerosene|gasoline|lighter\s*fluid|fuel\s*cell|fuel\s*canister)\b/i, label: "flammable fuel" },
  { re: /\b(flammable|combustible|corrosive|oxidizer|hazmat|hazardous)\b/i, label: "hazmat keyword" },
];

// Weaker signals — categories that commonly need SDS for certain SKUs.
const POSSIBLE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(paint|primer|stain|varnish|lacquer|sealant|epoxy|resin|adhesive|glue|caulk)\b/i, label: "paint/adhesive" },
  { re: /\b(cleaner|degreaser|disinfectant|sanitizer|solvent|stripper|polish|wax)\b/i, label: "cleaning product" },
  { re: /\b(fertilizer|plant\s*food|soil\s*treatment)\b/i, label: "fertilizer" },
  { re: /\b(perfume|cologne|fragrance|nail\s*polish|hair\s*spray|hair\s*dye|bleach\s*kit)\b/i, label: "cosmetic chemical" },
  { re: /\b(motor\s*oil|engine\s*oil|brake\s*fluid|transmission\s*fluid|antifreeze|coolant|grease|lubricant)\b/i, label: "automotive fluid" },
  { re: /\b(charger|powered|cordless|rechargeable|wireless\s*(mouse|keyboard|earbuds|headphones|speaker))\b/i, label: "contains battery (likely)" },
  { re: /\b(matches|lighter|firework|sparkler|candle\s*scented)\b/i, label: "ignition source" },
];

export function classifySds(productName: string | null | undefined): SdsClassification {
  const name = (productName ?? "").trim();
  if (!name) return { requirement: "Not required", reasons: [] };

  const strongHits = new Set<string>();
  for (const { re, label } of STRONG_PATTERNS) {
    if (re.test(name)) strongHits.add(label);
  }
  if (strongHits.size > 0) {
    return { requirement: "Likely required", reasons: Array.from(strongHits) };
  }

  const possibleHits = new Set<string>();
  for (const { re, label } of POSSIBLE_PATTERNS) {
    if (re.test(name)) possibleHits.add(label);
  }
  if (possibleHits.size > 0) {
    return { requirement: "Possibly required", reasons: Array.from(possibleHits) };
  }

  return { requirement: "Not required", reasons: [] };
}
