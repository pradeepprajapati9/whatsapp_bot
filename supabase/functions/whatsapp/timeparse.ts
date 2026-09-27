/**
 * timeparse.ts — turn what a patient types into a real date and time.
 *
 * WHY THIS FILE IS THE WHOLE PRODUCT
 *
 * A clinic does not pay for a chatbot. It pays to stop no-shows, and stopping a
 * no-show means sending a message the day before. To send anything the day
 * before, something has to be able to answer "who is coming tomorrow" — and a
 * free-text column cannot answer it. "Kal shaam 5 baje" is not a time a
 * computer can schedule against.
 *
 * So everything downstream depends on this: parse it once, at booking, while
 * the patient is still in the conversation and can correct us.
 *
 * TWO RULES IT FOLLOWS
 *
 * 1. NEVER GUESS SILENTLY. A wrong guess sends the patient at the wrong hour
 *    and the clinic gets blamed. Every result carries a confidence, and
 *    anything less than certain gets read back for confirmation.
 *
 * 2. WHEN IN DOUBT, PREFER CLINIC HOURS. "5 baje" in an OPD that runs
 *    10:00-19:00 means 5 PM, never 5 AM. This is not cleverness, it is the
 *    single most common ambiguity in Hinglish time.
 */

export type Confidence = "exact" | "likely" | "unsure";

export interface ParsedTime {
  at: Date | null;
  confidence: Confidence;
  /** What we understood, echoed back to the patient in their own language. */
  label: string;
  raw: string;
}

const HINDI_DIGITS: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

// Numbers people write as words, in all three languages they might use.
const WORD_NUMBERS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6,
  saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
  एक: 1, दो: 2, तीन: 3, चार: 4, पांच: 5, पाँच: 5, छह: 6, सात: 7,
  आठ: 8, नौ: 9, दस: 10, ग्यारह: 11, बारह: 12,
};

// Parts of the day. The ranges are what the words actually mean to a patient,
// not dictionary definitions.
const PERIODS: Array<[string[], [number, number]]> = [
  [["subah", "morning", "सुबह", "savere", "सवेरे"], [8, 12]],
  [["dopahar", "dupahar", "noon", "afternoon", "दोपहर"], [12, 16]],
  [["shaam", "sham", "evening", "शाम", "शामको"], [16, 20]],
  [["raat", "night", "रात"], [19, 22]],
];

const WEEKDAYS: Record<string, number> = {
  sunday: 0, ravivar: 0, itwar: 0, रविवार: 0, इतवार: 0,
  monday: 1, somvar: 1, somwar: 1, सोमवार: 1,
  tuesday: 2, mangalvar: 2, mangalwar: 2, मंगलवार: 2,
  wednesday: 3, budhvar: 3, budhwar: 3, बुधवार: 3,
  thursday: 4, guruvar: 4, brihaspativar: 4, गुरुवार: 4,
  friday: 5, shukravar: 5, shukrawar: 5, शुक्रवार: 5,
  saturday: 6, shanivar: 6, shaniwar: 6, शनिवार: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** India has no daylight saving, so a fixed offset is correct and simple. */
const IST_OFFSET_MIN = 330;

function nowIST(now?: Date): Date {
  const d = now ? new Date(now.getTime()) : new Date();
  return new Date(d.getTime() + (IST_OFFSET_MIN + d.getTimezoneOffset()) * 60000);
}

function normalize(text: string): string {
  let t = (text || "").toLowerCase().trim();
  for (const [hi, en] of Object.entries(HINDI_DIGITS)) t = t.split(hi).join(en);
  return t.replace(/[.,!]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Word-boundary matching that also works in Devanagari.
 *
 * JavaScript's  is defined against \w, which is ASCII-only, so /कल/ never
 * matches — the boundary test fails on both sides of a Hindi word. A patient
 * typing "कल शाम ५ बजे" was silently booked for TODAY, which is the worst class
 * of bug here: no error, no warning, just the wrong day.
 */
function hasWord(text: string, word: string): boolean {
  // The separator class is spelled with an explicit \\s escape because this is a
  // STRING being compiled to a regex, not a regex literal. Written as "[\s]" the
  // JavaScript string parser eats the backslash and the class silently becomes
  // [s] — it then matches the letter "s" instead of whitespace, every boundary
  // check fails, and every phrase quietly falls through to its default. That is
  // exactly what happened here: "कल शाम 5 baje" booked for TODAY and looked fine.
  const SEP = "[\\s,.!;:]";
  return new RegExp("(?:^|" + SEP + ")" + word + "(?=" + SEP + "|$)", "i").test(text);
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => hasWord(text, w));
}

/** Which day are they talking about? Returns days from today. */
function findDay(t: string, today: Date): { offset: number; explicit: boolean } {
  if (hasAny(t, ["aaj", "today", "आज"])) return { offset: 0, explicit: true };
  // "parso" is checked before "kal" because people stack them ("kal parso
  // dekhta hoon"), and the further day is the one they mean.
  if (hasAny(t, ["parso", "parson", "परसों"])) return { offset: 2, explicit: true };
  if (hasAny(t, ["kal", "tomorrow", "कल"])) return { offset: 1, explicit: true };

  for (const [word, dow] of Object.entries(WEEKDAYS)) {
    if (hasWord(t, word)) {
      // "Monday" said on a Monday means next Monday, not five minutes ago.
      let diff = (dow - today.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      return { offset: diff, explicit: true };
    }
  }

  // "28 Sep", "28/09", "28-09-2026"
  const dm = t.match(/\b(\d{1,2})[\s\-\/]+([a-z]{3,4}|\d{1,2})\b/);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mRaw = dm[2];
    const month = /^\d+$/.test(mRaw) ? parseInt(mRaw, 10) - 1 : MONTHS[mRaw.slice(0, 3)];
    if (day >= 1 && day <= 31 && month !== undefined && month >= 0 && month <= 11) {
      const target = new Date(today);
      target.setMonth(month, day);
      // A date already past means they mean next year.
      if (target.getTime() < today.getTime() - 86400000) target.setFullYear(target.getFullYear() + 1);
      const offset = Math.round((target.getTime() - today.getTime()) / 86400000);
      return { offset, explicit: true };
    }
  }
  return { offset: 0, explicit: false };
}

/** Which hour? Returns 24-hour time, or null if there is no clock time at all. */
function findHour(t: string, openHour: number, closeHour: number):
  { hour: number; minute: number; confidence: Confidence } | null {
  let period: [number, number] | null = null;
  for (const [words, range] of PERIODS) if (hasAny(t, words)) period = range;

  const explicitAmPm = /\b(am|pm|a\.m|p\.m)\b/.test(t);
  let hour: number | null = null;
  let minute = 0;

  // "5:30", "5.30", "17:00"
  const hm = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (hm) {
    hour = parseInt(hm[1], 10);
    minute = parseInt(hm[2], 10);
  } else {
    // "5 baje", "5 pm", "at 5"
    const h = t.match(/\b(\d{1,2})\s*(baje|बजे|am|pm|o'?clock)?\b/);
    if (h && parseInt(h[1], 10) <= 24) hour = parseInt(h[1], 10);
    if (hour === null) {
      for (const [word, n] of Object.entries(WORD_NUMBERS)) {
        // Same boundary problem as hasWord: \b cannot see the edges of a
        // Devanagari word, so "पांच बजे" would never match.
        if (hasWord(t, word + "(?:\\s*(?:baje|बजे|o'?clock))?")) {
          hour = n;
          break;
        }
      }
    }
  }
  if (hour === null) {
    // No clock time, but "shaam" alone is still usable — take the middle of it.
    if (period) return { hour: Math.floor((period[0] + period[1]) / 2), minute: 0, confidence: "unsure" };
    return null;
  }

  let confidence: Confidence = "exact";

  if (/\bpm\b|\bp\.m\b/.test(t) && hour < 12) hour += 12;
  else if (/\bam\b|\ba\.m\b/.test(t) && hour === 12) hour = 0;
  else if (period) {
    // "shaam 5" -> 17:00. The stated part of the day wins over the bare number.
    if (hour < 12 && period[0] >= 12) hour += 12;
  } else if (hour >= 1 && hour <= 11) {
    // A bare "5 baje" with nothing else. This is the ambiguity that matters, and
    // guessing wrong sends someone to a closed clinic at dawn — so prefer the
    // hour the clinic is actually open, and mark it for confirmation.
    const pmVersion = hour + 12;
    const amOpen = hour >= openHour && hour < closeHour;
    const pmOpen = pmVersion >= openHour && pmVersion < closeHour;
    if (pmOpen && !amOpen) hour = pmVersion;
    else if (pmOpen && amOpen) confidence = "likely";
    if (!explicitAmPm && confidence === "exact" && pmOpen) confidence = "likely";
  }
  return { hour, minute, confidence };
}

/**
 * Parse a patient's reply into a real appointment time.
 *
 * `openHour`/`closeHour` come from the clinic's own config, because the same
 * words mean different hours at a clinic that opens at 8 and one that opens at
 * 16.
 */
export function parseWhen(
  text: string,
  opts: { openHour?: number; closeHour?: number; now?: Date } = {},
): ParsedTime {
  const raw = (text || "").trim();
  const t = normalize(raw);
  const openHour = opts.openHour ?? 9;
  const closeHour = opts.closeHour ?? 20;
  const today = nowIST(opts.now);

  if (!t) return { at: null, confidence: "unsure", label: "", raw };

  const day = findDay(t, today);
  const clock = findHour(t, openHour, closeHour);

  if (!clock) {
    // A day with no time is still progress, but not something to schedule on.
    return { at: null, confidence: "unsure", label: "", raw };
  }

  const at = new Date(today);
  at.setDate(at.getDate() + day.offset);
  at.setHours(clock.hour, clock.minute, 0, 0);

  // "5 baje" said at 6 PM means tomorrow, not an hour ago. Only when they did
  // not name a day — if they explicitly said "aaj", respect it and let the
  // clinic deal with a same-day booking.
  if (!day.explicit && at.getTime() <= today.getTime()) {
    at.setDate(at.getDate() + 1);
  }

  let confidence = clock.confidence;
  if (!day.explicit) confidence = confidence === "exact" ? "likely" : "unsure";

  return { at, confidence, label: formatIST(at), raw };
}

/** Human-readable, in the format an Indian patient expects to read. */
export function formatIST(d: Date, lang: "hindi" | "english" | "hinglish" = "hinglish"): string {
  const DAYS = {
    hinglish: ["Ravivar", "Somvar", "Mangalvar", "Budhvar", "Guruvar", "Shukravar", "Shanivar"],
    hindi: ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"],
    english: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  }[lang];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}, ${h}:${mm} ${ampm}`;
}

/** Is this time inside the clinic's opening hours? */
export function isOpen(d: Date, openHour: number, closeHour: number, closedDays: number[] = [0]): boolean {
  if (closedDays.includes(d.getDay())) return false;
  const h = d.getHours() + d.getMinutes() / 60;
  return h >= openHour && h < closeHour;
}
