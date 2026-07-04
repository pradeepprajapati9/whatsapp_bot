"""
bot.py — Reply engine (free, keyword/rule based) + appointment booking flow.

No AI cost. Understands common Hinglish + English customer questions and
answers from a business's config.json. Also runs a small multi-step booking
flow (naam -> service -> time -> saved) so the bot captures leads, not just
answers FAQs. This module is WhatsApp-independent, so it can be tested locally
without any Meta setup (see test_bot.py).

Works for any "front-desk" business — clinic, salon, coaching, restaurant —
because everything (services/menu, booking labels, replies) comes from config.
"""

import json
import re
from pathlib import Path

import store

CONFIG_PATH = Path(__file__).with_name("config.json")


def load_config(path: Path = CONFIG_PATH) -> dict:
    """Load a business's info. One config.json per business = reusable template."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# --- Intent keywords ---------------------------------------------------------
# Each intent maps to a list of trigger words/roots. We match on normalized
# text, so "kitne", "kitna", "rate", "price", "₹" all hit the price intent.
# Order matters: the FIRST matching intent wins, so more specific intents
# (timing, appointment) are listed before broad ones (price).
INTENTS = {
    "greeting":    ["hi", "hello", "hey", "namaste", "namaskar", "hii", "helo", "start", "hlo"],
    # timing is checked BEFORE price so "kitne baje" (what time) beats the bare
    # "kitne" price trigger. A pure price question has no timing word and falls through.
    "timing":      ["timing", "time", "khula", "khule", "open", "band", "kab", "baje", "hours", "kitne baje", "closing", "opening"],
    # price is checked BEFORE appointment so "consultation ka price" shows the
    # fees instead of starting a booking (the service names are also booking words).
    "price":       ["price", "rate", "kitne", "kitna", "paise", "paisa", "cost", "kimat", "kīmat", "daam", "rs", "rupee", "₹", "charges", "fees", "fee"],
    # appointment/booking — the front-desk core.
    "appointment": ["appointment", "book", "booking", "slot", "checkup", "check up", "consult", "consultation",
                    "appoint", "dikhana", "dikhna", "milna", "visit", "aana hai", "aana chahta"],
    "menu":        ["menu", "list", "services", "service", "kya milta", "kya milega", "items", "dishes", "khana", "food", "available", "facility", "kya kya"],
    "address":     ["address", "location", "kaha", "kahan", "pata", "map", "reach", "kidhar", "shop", "clinic kaha"],
    "delivery":    ["delivery", "home delivery", "deliver", "ghar", "parcel", "pickup", "pick up"],
    "payment":     ["payment", "pay", "upi", "cash", "card", "gpay", "paytm", "phonepe", "online"],
    # generic "order" for shops/restaurants — routes to the same booking flow.
    "order":       ["order", "chahiye", "want", "chaiye", "de do", "dena", "mangwana", "lena"],
    "phone":       ["call", "phone", "number", "contact", "mobile", "sampark"],
    "thanks":      ["thanks", "thank", "dhanyavad", "shukriya", "thanku", "thx", "tq"],
}

# Words that abort an in-progress booking.
CANCEL_WORDS = {"cancel", "ruko", "ruko", "stop", "rehne do", "nahi", "band karo", "chodo"}


def normalize(text: str) -> str:
    """Lowercase and strip punctuation so keyword matching is forgiving."""
    text = text.lower().strip()
    # keep ₹ and word chars/spaces; drop other punctuation
    text = re.sub(r"[^\w\s₹]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def detect_intent(text: str) -> str | None:
    """Return the first intent whose keyword appears in the message, else None."""
    norm = normalize(text)
    padded = f" {norm} "
    for intent, keywords in INTENTS.items():
        for kw in keywords:
            # multi-word keyword: substring match; single word: whole-word match
            if " " in kw or kw == "₹":
                if kw in norm:
                    return intent
            elif f" {kw} " in padded:
                return intent
    return None


# --- Catalog helpers (works for both "services" and "menu") ------------------
def get_catalog(config: dict) -> tuple[list, str]:
    """Return (items, label). A clinic/salon has `services`; a shop has `menu`."""
    if config.get("services"):
        return config["services"], "Services"
    return config.get("menu", []), "Menu"


def _item_name(row: dict) -> str:
    return row.get("name") or row.get("item") or "—"


def format_catalog(config: dict) -> str:
    items, label = get_catalog(config)
    if not items:
        return "Details ke liye humein call kijiye 🙏"
    lines = [f"📋 *{label}*"]
    for row in items:
        price = row.get("price")
        if price is not None:
            lines.append(f"• {_item_name(row)} — ₹{price}")
        else:
            lines.append(f"• {_item_name(row)}")
    return "\n".join(lines)


def _numbered_catalog(config: dict) -> str:
    items, _ = get_catalog(config)
    return "\n".join(f"{i + 1}. {_item_name(row)}" for i, row in enumerate(items))


def _booking_label(config: dict) -> str:
    return config.get("booking", {}).get("label", "order")


def options_footer(config: dict) -> str:
    catalog_word = "services" if config.get("services") else "menu"
    label = _booking_label(config)
    return (
        "\nTaip kijiye:\n"
        f"👉 *{catalog_word}* • *price* • *timing* • *address* • *{label}*"
    )


# --- Tappable menu (WhatsApp interactive list) -------------------------------
# Each row's id is a word that detect_intent() understands, so tapping a row is
# the same as the customer typing that word. Titles must stay <= 24 chars.
MENU_ROWS = [
    ("services",    "🩺 Services & prices"),
    ("appointment", "📅 Book appointment"),
    ("timing",      "🕒 Clinic timings"),
    ("address",     "📍 Location"),
    ("phone",       "📞 Contact / call"),
]


def menu_rows(config: dict) -> list:
    """(id, title) rows for the tappable menu. A business can override with a
    `menu_rows` list in its config; otherwise the sensible default is used."""
    rows = config.get("menu_rows") or MENU_ROWS
    return [(r["id"], r["title"]) if isinstance(r, dict) else tuple(r) for r in rows]


def should_offer_menu(text: str, session: dict | None) -> bool:
    """Show the tappable menu on a greeting or an unrecognized message — but
    never mid-booking (that would interrupt the name/service/time questions)."""
    if session and session.get("flow"):
        return False
    return detect_intent(text) in ("greeting", None)


# --- Booking flow (multi-step; state lives in the per-customer `session`) -----
# session shape while a booking is active:
#   {"phone": "9199...", "flow": "appointment", "step": "name"|"service"|"time",
#    "data": {"name": ..., "service": ..., "time": ...}}
# When finished we clear "flow"/"step"/"data" and stash the saved record in
# session["_booked"] so the webhook layer can notify the owner.

def _start_booking(config: dict, session: dict) -> str:
    booking = config.get("booking", {})
    if not booking.get("enabled", False):
        # Booking not turned on for this business — give static instructions.
        return config.get("order_instructions", "Aap kya book karna chahenge, bata dijiye.")
    session["flow"] = "appointment"
    session["step"] = "name"
    session["data"] = {}
    label = _booking_label(config)
    ask = booking.get("ask_name", f"Great! {label.capitalize()} ke liye — aapka *naam* bataiye 🙂")
    return ask


def _continue_booking(text: str, config: dict, session: dict) -> str:
    booking = config.get("booking", {})
    norm = normalize(text)

    # Let the customer bail out at any step.
    if norm in {normalize(w) for w in CANCEL_WORDS}:
        _reset_flow(session)
        return "Koi baat nahi 🙏 Jab chahein type kijiye. " + options_footer(config).strip()

    step = session.get("step")
    data = session.setdefault("data", {})

    if step == "name":
        data["name"] = text.strip()
        session["step"] = "service"
        ask = booking.get("ask_service", "Kis cheez ke liye? Neeche list se number ya naam bhejein:")
        return f"{ask}\n\n{_numbered_catalog(config)}"

    if step == "service":
        items, _ = get_catalog(config)
        choice = text.strip()
        if choice.isdigit() and 1 <= int(choice) <= len(items):
            data["service"] = _item_name(items[int(choice) - 1])
        else:
            data["service"] = choice
        session["step"] = "time"
        ask = booking.get(
            "ask_time",
            "Kis *din aur time* aana chahenge? (jaise: 'Kal shaam 5 baje' ya 'Monday morning')",
        )
        return ask

    if step == "time":
        data["time"] = text.strip()
        return _finalize_booking(config, session)

    # Shouldn't happen — reset defensively.
    _reset_flow(session)
    return "Kuch gadbad ho gayi 🙏 Firse type kijiye." + options_footer(config)


def _finalize_booking(config: dict, session: dict) -> str:
    data = session.get("data", {})
    record = store.save_appointment({
        "business": config.get("business_name", ""),
        "name": data.get("name", ""),
        "phone": session.get("phone", ""),
        "service": data.get("service", ""),
        "time": data.get("time", ""),
    })
    session["_booked"] = record          # webhook layer notifies the owner
    _reset_flow(session)

    label = _booking_label(config).capitalize()
    note = config.get("booking", {}).get(
        "confirm_note",
        "Hamara staff aapko call karke *confirm* kar dega.",
    )
    return (
        f"✅ *{label} request mil gayi!*\n\n"
        f"👤 Naam: {record['name']}\n"
        f"🩺 Ke liye: {record['service']}\n"
        f"🕒 Time: {record['time']}\n\n"
        f"{note}"
    )


def _reset_flow(session: dict) -> None:
    for k in ("flow", "step", "data"):
        session.pop(k, None)


# --- Main entry --------------------------------------------------------------
def build_reply(text: str, config: dict, session: dict | None = None,
                interactive: bool = False) -> str:
    """Core: message text -> reply string. This is what the webhook sends back.

    `session` (a mutable dict, one per customer) enables the multi-step booking
    flow. If it's None, FAQ answers still work but booking can't remember state.
    `interactive=True` drops the typed-options footer, because the caller is
    attaching a tappable menu instead (see app.py send_menu).
    """
    if session is None:
        session = {}
    name = config.get("business_name", "our shop")
    footer = "" if interactive else options_footer(config)

    # 1. If a booking is in progress, the message is an answer to the flow.
    if session.get("flow"):
        return _continue_booking(text, config, session)

    intent = detect_intent(text)

    # 2. Booking triggers (appointment for clinics/salons, order for shops).
    if intent in ("appointment", "order"):
        return _start_booking(config, session)

    if intent == "greeting":
        greeting = config.get("greeting", "Hello!").format(business_name=name)
        return greeting + footer

    if intent in ("price", "menu"):
        return format_catalog(config) + "\n\n" + config.get("closing_line", "")

    if intent == "timing":
        return config.get("timing", "Please call us for timings.")

    if intent == "address":
        return config.get("address", "Please call us for the address.")

    if intent == "delivery":
        return config.get("delivery", "Please ask us about delivery.")

    if intent == "payment":
        return config.get("payment", "We accept common payment methods.")

    if intent == "phone":
        return config.get("phone", "Please message us here.")

    if intent == "thanks":
        return f"Aapka dhanyavad! 🙏 {name} me firse aaiyega."

    # Fallback: we didn't understand — guide them to valid options.
    return (
        f"Namaste! 🙏 Main {name} ka assistant hoon. "
        "Aapki baat samajh nahi aayi." + footer
    )
