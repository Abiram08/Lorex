/** Language packs: durable-signal markers as data, so contributors can add a
 * language without touching extraction logic.
 *
 * Shape: each pack lists regex SOURCE fragments (word-bounded where the
 * language allows) tagged by signal class. CJK entries are matched as plain
 * substrings because those scripts have no word boundaries — mark them with
 * "cjk": true and they must NOT contain regex metacharacters.
 * */

export interface LanguagePack {
  code: string;
  decision: Array<{ s: string; cjk?: boolean }>;
  preference: Array<{ s: string; cjk?: boolean }>;
  constraint: Array<{ s: string; cjk?: boolean }>;
  correction: Array<{ s: string; cjk?: boolean }>;
}

export const LANGUAGE_PACKS: LanguagePack[] = [
  {
    code: "es-pt",
    decision: [
      { s: "decidimos?" }, { s: "decid[ií]" }, { s: "elegimos" }, { s: "optamos" },
      { s: "usamos" }, { s: "migramos" }, { s: "mudamos para" }, { s: "cambiamos a" },
      { s: "substitu[íi]dos? por" }, { s: "vamos a usar" },
    ],
    preference: [{ s: "prefiero" }, { s: "prefiro" }],
    constraint: [{ s: "no se permite" }, { s: "obligatorio" }, { s: "proibido" }],
    correction: [],
  },
  {
    code: "fr",
    decision: [
      { s: "d[ée]cid[ée]" }, { s: "choisi" }, { s: "on utilise" }, { s: "migr[ée] vers" },
      { s: "remplac[ée] par" }, { s: "on va utiliser" },
    ],
    preference: [{ s: "nous pr[ée]f[ée]rons" }, { s: "m'ieux" }],
    constraint: [{ s: "interdit" }, { s: "obligatoire" }],
    correction: [],
  },
  {
    code: "de",
    decision: [
      { s: "entschieden" }, { s: "wir nutzen" }, { s: "wir verwenden" },
      { s: "umgestiegen auf" }, { s: "migriert zu" }, { s: "ersetzt durch" },
    ],
    preference: [{ s: "bevorzugen" }],
    constraint: [{ s: "verboten" }, { s: "nicht erlaubt" }],
    correction: [],
  },
  {
    code: "it",
    decision: [{ s: "deciso" }, { s: "usiamo" }, { s: "migrato a" }, { s: "sostituito con" }],
    preference: [{ s: "preferiamo" }],
    constraint: [{ s: "vietato" }],
    correction: [],
  },
  {
    code: "zh-ja",
    decision: [
      { s: "决定", cjk: true }, { s: "決定", cjk: true }, { s: "改用", cjk: true },
      { s: "迁移到", cjk: true }, { s: "遷移到", cjk: true }, { s: "移行", cjk: true },
      { s: "切り替え", cjk: true }, { s: "採用", cjk: true },
    ],
    preference: [],
    constraint: [],
    correction: [{ s: "不对", cjk: true }, { s: "其实", cjk: true }, { s: "ではなく", cjk: true }],
  },
];

function alternates(entries: Array<{ s: string; cjk?: boolean }>): {
  regexParts: string[];
  substrings: string[];
} {
  const regexParts: string[] = [];
  const substrings: string[] = [];
  for (const e of entries) {
    if (e.cjk) substrings.push(e.s);
    else regexParts.push(e.s);
  }
  return { regexParts, substrings };
}

const compiled = LANGUAGE_PACKS.map((p) => ({
  decision: alternates(p.decision),
  preference: alternates(p.preference),
  constraint: alternates(p.constraint),
  correction: alternates(p.correction),
}));

function anyRegex(parts: string[]): RegExp | null {
  if (parts.length === 0) return null;
  return new RegExp(`\\b(?:${parts.join("|")})\\b`, "i");
}

export const PACKED = {
  decisionRegexes: compiled
    .map((c) => anyRegex(c.decision.regexParts))
    .filter((r): r is RegExp => r !== null),
  preferenceRegexes: compiled.map((c) => anyRegex(c.preference.regexParts)).filter((r): r is RegExp => r !== null),
  constraintRegexes: compiled.map((c) => anyRegex(c.constraint.regexParts)).filter((r): r is RegExp => r !== null),
  decisionSubstrings: compiled.flatMap((c) => c.decision.substrings),
  correctionSubstrings: compiled.flatMap((c) => c.correction.substrings),
};
