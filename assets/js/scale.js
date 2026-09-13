// ---------------------------------------------------------------------
// Ingredient scaling: "0.5 cups heavy cream" at 2x -> "1 cup heavy cream".
//
// Only the quantity at the very START of a line is scaled. Numbers later in
// the line ("quartered (for 9x12 pan)", "a 14-oz can") are descriptions, not
// amounts, and are left alone. Lines with no leading quantity ("Salt to
// taste") pass through unchanged.
// ---------------------------------------------------------------------

const GLYPHS = {
  '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4,
  '⅓': 1 / 3, '⅔': 2 / 3, '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const GLYPH_CLASS = '[¼½¾⅓⅔⅙⅚⅛⅜⅝⅞]';

// Most specific forms first: "1 1/2", "1½", "3/4", "0.5", "2", "½".
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\s*${GLYPH_CLASS}|\d+\/\d+|\d*\.\d+|\d+|${GLYPH_CLASS})`;

// Leading quantity, optionally a range ("2-3", "2 to 3"), followed by a
// space, a letter ("500g") or the end of the line — but never a dimension
// like "9x12" or "3 x 4", which describes a pan or a cut, not an amount.
const LEADING = new RegExp(
  String.raw`^(\s*)(${NUM})(?:(\s*(?:-|–|—|to)\s*)(${NUM}))?(?=\s|[A-Za-z]|$)(?!\s*[xX×]\s*\d)`,
);

function parseNum(token) {
  const t = token.trim();
  let m;
  if ((m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[1] + (+m[3] ? +m[2] / +m[3] : 0);
  if ((m = t.match(new RegExp(`^(\\d+)\\s*(${GLYPH_CLASS})$`)))) return +m[1] + GLYPHS[m[2]];
  if ((m = t.match(/^(\d+)\/(\d+)$/))) return +m[2] ? +m[1] / +m[2] : NaN;
  if (t in GLYPHS) return GLYPHS[t];
  return parseFloat(t);
}

/**
 * Recipe exporters round fractions to decimals: 1/3 cup becomes "0.3" or
 * "0.33". Recover the fraction the cook meant so 0.3 x 2 shows as ⅔ rather
 * than 0.6. Only decimals are snapped, and only when they're very close to a
 * third, or essentially on an eighth — a deliberate "0.4" stays 0.4.
 */
function snapDecimal(token, value) {
  if (!/^\d*\.\d{1,2}$/.test(token.trim())) return value;
  const whole = Math.floor(value);
  const frac = value - whole;
  for (const third of [1 / 3, 2 / 3]) {
    if (Math.abs(frac - third) <= 0.035) return whole + third;
  }
  for (let e = 1; e < 8; e++) {
    if (Math.abs(frac - e / 8) <= 0.006) return whole + e / 8;
  }
  return value;
}

const FRACTION_GLYPH = {
  '1/8': '⅛', '1/4': '¼', '3/8': '⅜', '1/2': '½', '5/8': '⅝', '3/4': '¾', '7/8': '⅞',
  '1/3': '⅓', '2/3': '⅔', '1/6': '⅙', '5/6': '⅚',
};

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

/** 0.75 -> "¾", 1.5 -> "1½", 1/12 -> "1⁄12", 1.4 -> "1.4". */
export function formatQuantity(x) {
  if (!Number.isFinite(x) || x <= 0) return '0';
  for (const den of [1, 2, 3, 4, 8, 12, 16]) {
    const total = Math.round(x * den);
    if (Math.abs(x - total / den) > 0.004) continue;
    const whole = Math.floor(total / den);
    let num = total - whole * den;
    if (num === 0) return String(whole);
    const g = gcd(num, den);
    num /= g;
    const d = den / g;
    const glyph = FRACTION_GLYPH[`${num}/${d}`] ?? `${num}⁄${d}`;
    return whole ? `${whole}${glyph}` : glyph;
  }
  // Not a kitchen fraction: keep it honest rather than force a nearby one.
  return String(Math.round(x * 100) / 100);
}

// Units whose grammatical number should follow the scaled amount
// ("1 cups" -> "½ cup", "1 dash" -> "2 dashes"). Abbreviations like tbsp,
// tsp, oz, lb and g don't inflect, so they're simply absent from this table.
const UNIT_FORMS = [
  ['cup', 'cups'], ['tablespoon', 'tablespoons'], ['teaspoon', 'teaspoons'],
  ['pound', 'pounds'], ['ounce', 'ounces'], ['gram', 'grams'],
  ['kilogram', 'kilograms'], ['liter', 'liters'], ['litre', 'litres'],
  ['milliliter', 'milliliters'], ['quart', 'quarts'], ['pint', 'pints'],
  ['gallon', 'gallons'], ['clove', 'cloves'], ['can', 'cans'], ['jar', 'jars'],
  ['stick', 'sticks'], ['slice', 'slices'], ['sprig', 'sprigs'],
  ['piece', 'pieces'], ['package', 'packages'], ['head', 'heads'],
  ['handful', 'handfuls'], ['pinch', 'pinches'], ['dash', 'dashes'],
  ['bunch', 'bunches'],
];
const UNIT_LOOKUP = new Map();
for (const [one, many] of UNIT_FORMS) {
  UNIT_LOOKUP.set(one, [one, many]);
  UNIT_LOOKUP.set(many, [one, many]);
}

/**
 * English takes the singular for exactly one and for fractions below one
 * ("1 cup", "¾ cup"), but the plural for everything else, decimals included
 * ("1½ cups", "0.8 cups").
 */
function isSingular(quantityText, amount) {
  return quantityText === '1' || (amount < 1 && !quantityText.includes('.'));
}

function inflectUnit(rest, singular) {
  const m = rest.match(/^(\s+)([A-Za-z]+)\b/);
  if (!m) return rest;
  const forms = UNIT_LOOKUP.get(m[2].toLowerCase());
  if (!forms) return rest;
  let word = singular ? forms[0] : forms[1];
  if (m[2][0] === m[2][0].toUpperCase()) word = word[0].toUpperCase() + word.slice(1);
  return m[1] + word + rest.slice(m[0].length);
}

/**
 * Scale one ingredient line. At a factor of 1 the original text is returned
 * untouched, exactly as the recipe author wrote it.
 */
export function scaleIngredient(line, factor) {
  const text = String(line);
  if (factor === 1) return text;

  const m = text.match(LEADING);
  if (!m) return text;

  const [whole, lead, firstTok, sep, secondTok] = m;
  const first = snapDecimal(firstTok, parseNum(firstTok));
  if (!Number.isFinite(first)) return text;

  let amount = first * factor;
  let last = formatQuantity(amount);
  let quantity = last;

  if (secondTok) {
    const second = snapDecimal(secondTok, parseNum(secondTok));
    if (!Number.isFinite(second)) return text;
    amount = second * factor;
    last = formatQuantity(amount);
    quantity += sep + last;
  }

  // A range's unit agrees with its upper bound: "1 to 1½ tablespoons".
  const rest = text.slice(whole.length);
  return lead + quantity + inflectUnit(rest, isSingular(last, amount));
}

export const SCALE_OPTIONS = [
  { factor: 0.25, label: '¼×', name: 'Quarter' },
  { factor: 0.5, label: '½×', name: 'Half' },
  { factor: 1, label: '1×', name: 'Original' },
  { factor: 2, label: '2×', name: 'Double' },
  { factor: 3, label: '3×', name: 'Triple' },
];
