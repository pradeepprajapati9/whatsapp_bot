"""
app.py — WhatsApp Cloud API webhook (Flask).

Two endpoints on /webhook:
  GET  -> Meta's one-time verification handshake (echoes hub.challenge).
  POST -> incoming customer messages; we reply via the Graph API.

Keeps a small in-memory session per customer so the multi-step booking flow
(naam -> service -> time) can remember where each conversation is. When a
booking finishes, the business owner gets a WhatsApp notification.

Setup: see README.md. Needs env vars (see .env.example).
"""

import os
import requests
from flask import Flask, request

# Load credentials from a local .env file if present (real deployments set real
# env vars instead). Graceful if python-dotenv isn't installed.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from bot import load_config, build_reply, menu_rows, should_offer_menu

app = Flask(__name__)
CONFIG = load_config()

# Per-customer conversation state, keyed by WhatsApp number. In-memory is fine
# for a single-process MVP (one business). For multi-worker/multi-tenant, move
# this to Supabase (see PLAN.md).
SESSIONS: dict[str, dict] = {}

# --- Credentials from environment (never hard-code tokens) -------------------
VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN", "my_verify_token")
ACCESS_TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID", "")
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v21.0")
# Owner's WhatsApp number (country code, no +) for new-booking alerts. Optional;
# can also be set per-business in config.json ("owner_wa").
OWNER_WA = os.environ.get("OWNER_WA", "") or CONFIG.get("owner_wa", "")

GRAPH_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages"


@app.route("/webhook", methods=["GET"])
def verify():
    """Meta calls this once when you register the webhook."""
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")
    if mode == "subscribe" and token == VERIFY_TOKEN:
        return challenge, 200
    return "Verification failed", 403


@app.route("/webhook", methods=["POST"])
def incoming():
    """Handle an incoming customer message and reply."""
    data = request.get_json(silent=True) or {}
    try:
        entry = data["entry"][0]["changes"][0]["value"]
        messages = entry.get("messages")
        if not messages:
            # Could be a status update (delivered/read) — ignore.
            return "ok", 200

        msg = messages[0]
        sender = msg["from"]                 # customer's WhatsApp number
        text = _incoming_text(msg)           # plain text OR a tapped menu id

        session = SESSIONS.setdefault(sender, {"phone": sender})
        offer_menu = should_offer_menu(text, session)
        reply = build_reply(text, CONFIG, session, interactive=offer_menu)
        if offer_menu and not session.get("flow"):
            send_menu(sender, reply)         # reply + tappable option list
        else:
            send_message(sender, reply)

        # If a booking just completed, alert the business owner.
        booked = session.pop("_booked", None)
        if booked:
            notify_owner(booked)
    except (KeyError, IndexError):
        # Malformed / unexpected payload — acknowledge so Meta doesn't retry.
        pass
    return "ok", 200


def _incoming_text(msg: dict) -> str:
    """Return the customer's typed text, or the id of a tapped menu row/button
    (WhatsApp sends taps as an 'interactive' message, not plain text)."""
    if msg.get("type") == "interactive":
        inter = msg.get("interactive", {})
        chosen = inter.get("list_reply") or inter.get("button_reply") or {}
        return chosen.get("id", "")
    return msg.get("text", {}).get("body", "")


def _headers() -> dict:
    return {"Authorization": f"Bearer {ACCESS_TOKEN}", "Content-Type": "application/json"}


def send_message(to: str, body: str) -> None:
    """Send a text message back to the customer via the Cloud API."""
    if not ACCESS_TOKEN or not PHONE_NUMBER_ID:
        print(f"[DRY RUN] would send to {to}:\n{body}\n")
        return

    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "text",
        "text": {"body": body},
    }
    resp = requests.post(GRAPH_URL, json=payload, headers=_headers(), timeout=15)
    if resp.status_code >= 400:
        print(f"[send error {resp.status_code}] {resp.text}")


def send_menu(to: str, body: str) -> None:
    """Send the reply text together with a tappable option list, so the customer
    can pick 'Services', 'Book appointment', etc. instead of typing it."""
    rows = menu_rows(CONFIG)
    if not ACCESS_TOKEN or not PHONE_NUMBER_ID:
        print(f"[DRY RUN] menu to {to}:\n{body}\n  rows={[r[0] for r in rows]}\n")
        return

    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": body[:1024]},
            "action": {
                "button": "Menu ▾",
                "sections": [{
                    "title": "How can I help?",
                    "rows": [{"id": rid, "title": title[:24]} for rid, title in rows],
                }],
            },
        },
    }
    resp = requests.post(GRAPH_URL, json=payload, headers=_headers(), timeout=15)
    if resp.status_code >= 400:
        print(f"[menu send error {resp.status_code}] {resp.text}")
        send_message(to, body)   # fallback so the customer still gets a reply


def notify_owner(record: dict) -> None:
    """Ping the business owner about a new booking/lead.

    Note: a proactive message to the owner works only if the owner messaged the
    number in the last 24h; otherwise Meta requires an approved template. For the
    MVP we attempt a plain text (and always keep the lead saved in
    appointments.json / the dashboard as the reliable record)."""
    if not OWNER_WA:
        return
    text = (
        "🔔 *Nayi booking!*\n"
        f"👤 {record.get('name')}  (📞 {record.get('phone')})\n"
        f"🩺 {record.get('service')}\n"
        f"🕒 {record.get('time')}"
    )
    send_message(OWNER_WA, text)


@app.route("/", methods=["GET"])
def health():
    return f"{CONFIG.get('business_name')} WhatsApp bot is running ✅", 200


if __name__ == "__main__":
    # For local dev only. In production run via gunicorn / a WSGI server.
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
