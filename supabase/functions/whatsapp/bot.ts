/**
 * bot.ts — reply engine (free, keyword/rule based) + appointment booking flow.
 *
 * Direct port of the Python MVP's bot.py. No AI cost. Understands common
 * Hinglish + English customer questions and answers from the business config.
 * WhatsApp-independent, so it can be unit-tested without any Meta setup.
 *
 * The one real difference from bot.py: `session` is a plain object the caller
 * loads from / saves to Postgres, because Edge Functions keep nothing in
 * memory between requests.
 */

import { type BizConfig, type CatalogItem } from "./config.ts";

export interface Session {
  phone: string;
  flow?: string;
  step?: "name" | "service" | "time";
  data?: { name?: string; service?: string; time?: string };
  _booked?: Record<string, string>;
}

export type SaveFn = (record: Record<string, string>) => Promise<Record<string, string>>;

// --- Intent keywords --------------------------------------------------------
// First matching intent wins, so more specific intents (timing, appointment)
// come before broad ones (price). Kept as an array — unlike a Python dict, an
// array makes that ordering guarantee explicit.
const INTENTS: Array<[string, string[]]> = [
  ["greeting", ["hi", "hello", "hey", "namaste", "namaskar", "hii", "helo", "start", "hlo"]],
  // timing before price so "kitne baje" (what time) beats the bare "kitne"
  // price trigger. A pure price question has no timing word and falls through.
  ["timing", ["timing", "time", "khula", "khule", "open", "band", "kab", "baje", "hours", "kitne baje", "closing", "opening"]],
  // price before appointment so "consultation ka price" shows fees instead of
  // starting a booking (service names double as booking words).
  ["price", ["price", "rate", "kitne", "kitna", "paise", "paisa", "cost", "kimat", "kīmat", "daam", "rs", "rupee", "₹", "charges", "fees", "fee"]],
  ["appointment", ["appointment", "book", "booking", "slot", "checkup", "check up", "consult", "consultation", "appoint", "dikhana", "dikhna", "milna", "visit", "aana hai", "aana chahta"]],
  ["menu", ["menu", "list", "services", "service", "kya milta", "kya milega", "items", "dishes", "khana", "food", "available", "facility", "kya kya"]],
  ["address", ["address", "location", "kaha", "kahan", "pata", "map", "reach", "kidhar", "shop", "clinic kaha"]],
  ["delivery", ["delivery", "home delivery", "deliver", "ghar", "parcel", "pickup", "pick up"]],
  ["payment", ["payment", "pay", "upi", "cash", "card", "gpay", "paytm", "phonepe", "online"]],
  ["order", ["order", "chahiye", "want", "chaiye", "de do", "dena", "mangwana", "lena"]],
  ["phone", ["call", "phone", "number", "contact", "mobile", "sampark"]],
  ["thanks", ["thanks", "thank", "dhanyavad", "shukriya", "thanku", "thx", "tq"]],
];

// Words that abort an in-progress booking.
const CANCEL_WORDS = ["cancel", "ruko", "stop", "rehne do", "nahi", "band karo", "chodo"];

/** Lowercase and strip punctuation so keyword matching is forgiving.
 *  Uses \p{L}/\p{N} rather than \w so Devanagari survives, matching Python's
 *  unicode-aware \w. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}_\s₹]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First intent whose keyword appears in the message, else null. */
export function detectIntent(text: string): string | null {
  const norm = normalize(text);
  const padded = " " + norm + " ";
  for (const [intent, keywords] of INTENTS) {
    for (const kw of keywords) {
      // multi-word keyword: substring match; single word: whole-word match
      if (kw.includes(" ") || kw === "₹") {
        if (norm.includes(kw)) return intent;
      } else if (padded.includes(" " + kw + " ")) {
        return intent;
      }
    }
  }
  return null;
}

// --- Catalog helpers (works for both "services" and "menu") -----------------
function getCatalog(config: BizConfig): [CatalogItem[], string] {
  if (config.services && config.services.length) return [config.services, "Services"];
  return [config.menu ?? [], "Menu"];
}

function itemName(row: CatalogItem): string {
  return row.name || row.item || "—";
}

export function formatCatalog(config: BizConfig): string {
  const [items, label] = getCatalog(config);
  if (!items.length) return "Details ke liye humein call kijiye 🙏";
  const lines = ["📋 *" + label + "*"];
  for (const row of items) {
    lines.push(
      row.price != null ? "• " + itemName(row) + " — ₹" + row.price : "• " + itemName(row),
    );
  }
  return lines.join("\n");
}

function numberedCatalog(config: BizConfig): string {
  const [items] = getCatalog(config);
  return items.map((row, i) => i + 1 + ". " + itemName(row)).join("\n");
}

function bookingLabel(config: BizConfig): string {
  return config.booking?.label ?? "order";
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function optionsFooter(config: BizConfig): string {
  const catalogWord = config.services && config.services.length ? "services" : "menu";
  return (
    "\nTaip kijiye:\n👉 *" + catalogWord + "* • *price* • *timing* • *address* • *" +
    bookingLabel(config) + "*"
  );
}

// --- Tappable menu (WhatsApp interactive list) ------------------------------
// Each row id is a word detectIntent() understands, so tapping a row equals
// typing that word. Titles must stay <= 24 chars.
const MENU_ROWS: Array<[string, string]> = [
  ["services", "🩺 Services & prices"],
  ["appointment", "📅 Book appointment"],
  ["timing", "🕒 Clinic timings"],
  ["address", "📍 Location"],
  ["phone", "📞 Contact / call"],
];

export function menuRows(config: BizConfig): Array<[string, string]> {
  if (config.menu_rows && config.menu_rows.length) {
    return config.menu_rows.map((r) => [r.id, r.title] as [string, string]);
  }
  return MENU_ROWS;
}

/** Show the tappable menu on a greeting or an unrecognized message — but never
 *  mid-booking (that would interrupt the name/service/time questions). */
export function shouldOfferMenu(text: string, session: Session | null): boolean {
  if (session && session.flow) return false;
  const intent = detectIntent(text);
  return intent === "greeting" || intent === null;
}

// --- Booking flow (multi-step; state lives in `session`) --------------------
function startBooking(config: BizConfig, session: Session): string {
  const booking = config.booking ?? {};
  if (!booking.enabled) {
    // Booking not turned on for this business — give static instructions.
    return config.order_instructions ?? "Aap kya book karna chahenge, bata dijiye.";
  }
  session.flow = "appointment";
  session.step = "name";
  session.data = {};
  return (
    booking.ask_name ??
    "Great! " + capitalize(bookingLabel(config)) + " ke liye — aapka *naam* bataiye 🙂"
  );
}

async function continueBooking(
  text: string,
  config: BizConfig,
  session: Session,
  saveAppointment: SaveFn,
): Promise<string> {
  const booking = config.booking ?? {};
  const norm = normalize(text);

  // Let the customer bail out at any step.
  if (CANCEL_WORDS.some((w) => normalize(w) === norm)) {
    resetFlow(session);
    return "Koi baat nahi 🙏 Jab chahein type kijiye. " + optionsFooter(config).trim();
  }

  const data = (session.data ??= {});

  if (session.step === "name") {
    data.name = text.trim();
    session.step = "service";
    const ask = booking.ask_service ?? "Kis cheez ke liye? Neeche list se number ya naam bhejein:";
    return ask + "\n\n" + numberedCatalog(config);
  }

  if (session.step === "service") {
    const [items] = getCatalog(config);
    const choice = text.trim();
    const n = Number(choice);
    data.service =
      /^\d+$/.test(choice) && n >= 1 && n <= items.length ? itemName(items[n - 1]) : choice;
    session.step = "time";
    return (
      booking.ask_time ??
      "Kis *din aur time* aana chahenge? (jaise: 'Kal shaam 5 baje' ya 'Monday morning')"
    );
  }

  if (session.step === "time") {
    data.time = text.trim();
    return await finalizeBooking(config, session, saveAppointment);
  }

  // Shouldn't happen — reset defensively.
  resetFlow(session);
  return "Kuch gadbad ho gayi 🙏 Firse type kijiye." + optionsFooter(config);
}

async function finalizeBooking(
  config: BizConfig,
  session: Session,
  saveAppointment: SaveFn,
): Promise<string> {
  const data = session.data ?? {};
  const record = await saveAppointment({
    business: config.business_name ?? "",
    name: data.name ?? "",
    phone: session.phone ?? "",
    service: data.service ?? "",
    time: data.time ?? "",
  });
  session._booked = record; // the webhook layer notifies the owner
  resetFlow(session);

  const note = config.booking?.confirm_note ??
    "Hamara staff aapko call karke *confirm* kar dega.";
  return (
    "✅ *" + capitalize(bookingLabel(config)) + " request mil gayi!*\n\n" +
    "👤 Naam: " + record.name + "\n" +
    "🩺 Ke liye: " + record.service + "\n" +
    "🕒 Time: " + record.time + "\n\n" +
    note
  );
}

function resetFlow(session: Session): void {
  delete session.flow;
  delete session.step;
  delete session.data;
}

/**
 * Core: message text -> reply string. This is what the webhook sends back.
 *
 * `session` is one mutable object per customer (loaded from Postgres) and
 * enables the multi-step booking flow. `interactive=true` drops the typed-
 * options footer, because the caller is attaching a tappable menu instead.
 */
export async function buildReply(
  text: string,
  config: BizConfig,
  session: Session,
  interactive: boolean,
  saveAppointment: SaveFn,
): Promise<string> {
  const name = config.business_name ?? "our shop";
  const footer = interactive ? "" : optionsFooter(config);

  // 1. If a booking is in progress, the message answers the flow.
  if (session.flow) return await continueBooking(text, config, session, saveAppointment);

  const intent = detectIntent(text);

  // 2. Booking triggers (appointment for clinics/salons, order for shops).
  if (intent === "appointment" || intent === "order") return startBooking(config, session);

  if (intent === "greeting") {
    const greeting = (config.greeting ?? "Hello!").replace("{business_name}", name);
    return greeting + footer;
  }

  if (intent === "price" || intent === "menu") {
    return formatCatalog(config) + "\n\n" + (config.closing_line ?? "");
  }

  if (intent === "timing") return config.timing ?? "Please call us for timings.";
  if (intent === "address") return config.address ?? "Please call us for the address.";
  if (intent === "delivery") return config.delivery ?? "Please ask us about delivery.";
  if (intent === "payment") return config.payment ?? "We accept common payment methods.";
  if (intent === "phone") return config.phone ?? "Please message us here.";
  if (intent === "thanks") return "Aapka dhanyavad! 🙏 " + name + " me firse aaiyega.";

  // Fallback: we didn't understand — guide them to valid options.
  return "Namaste! 🙏 Main " + name + " ka assistant hoon. Aapki baat samajh nahi aayi." + footer;
}
