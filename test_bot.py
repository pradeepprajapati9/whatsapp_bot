"""
test_bot.py — Try the bot WITHOUT any WhatsApp/Meta setup.

Ways to run:
  python test_bot.py            -> FAQ samples + a full booking conversation
  python test_bot.py --chat     -> interactive chat in your terminal (booking works)
  python test_bot.py --config configs/salon.json   -> test a different business
"""

import sys
from bot import load_config, build_reply

# Windows terminals default to cp1252 and can't print emoji — force UTF-8.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# One-off FAQ questions (each is a fresh conversation).
SAMPLES = [
    "Hello",
    "bhaiya consultation ka price kya hai",
    "services bhejo",
    "kitne baje tak khula hai",
    "location kaha hai",
    "upi chalega?",
    "thank you",
    "kuch bhi random baat",
]

# A booking is multi-step, so these run in ONE shared session.
BOOKING_FLOW = [
    "appointment book karni hai",
    "Rahul Sharma",
    "2",                       # picks the 2nd service by number
    "kal shaam 5 baje",
]


def run_samples(config):
    print("\n===== FAQ samples =====")
    for text in SAMPLES:
        print(f"\n👤 Customer: {text}")
        print(f"🤖 Bot:\n{build_reply(text, config)}")
        print("-" * 50)

    print("\n\n===== Booking flow (one conversation) =====")
    session = {"phone": "919999999999"}   # dummy customer number
    for text in BOOKING_FLOW:
        print(f"\n👤 Customer: {text}")
        print(f"🤖 Bot:\n{build_reply(text, config, session)}")
        print("-" * 50)
    if session.get("_booked"):
        print(f"\n💾 Saved lead -> appointments.json: {session['_booked']}")


def run_chat(config):
    print("Chat mode — type 'quit' to exit.\n")
    session = {"phone": "919999999999"}
    while True:
        try:
            text = input("👤 You: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if text.lower() in ("quit", "exit", "q"):
            break
        print(f"🤖 Bot:\n{build_reply(text, config, session)}\n")
        if session.pop("_booked", None):
            print("   (💾 booking saved to appointments.json)\n")


def _config_path_from_args():
    if "--config" in sys.argv:
        i = sys.argv.index("--config")
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


if __name__ == "__main__":
    path = _config_path_from_args()
    cfg = load_config(path) if path else load_config()
    if "--chat" in sys.argv:
        run_chat(cfg)
    else:
        run_samples(cfg)
