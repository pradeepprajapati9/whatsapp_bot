"""
send_test.py — PROVE the bot is real.

Sends an actual WhatsApp message to your own number using your Cloud API
credentials. If your phone buzzes, the connection is real and working.

Usage:
    python send_test.py 919876543210        # your number, country code, no +

Needs WHATSAPP_TOKEN and PHONE_NUMBER_ID set (in .env or env vars).
Note: Meta lets you message a number only after it's added as a "recipient"
in the API Setup page (test numbers), OR once your app is live.
"""

import os
import sys

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import requests

TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
PHONE_NUMBER_ID = os.environ.get("PHONE_NUMBER_ID", "")
VERSION = os.environ.get("GRAPH_API_VERSION", "v21.0")


def main():
    if len(sys.argv) < 2:
        print("Usage: python send_test.py <your_number_with_country_code>")
        print("Example: python send_test.py 919876543210")
        sys.exit(1)

    to = sys.argv[1].lstrip("+")

    if not TOKEN or not PHONE_NUMBER_ID:
        print("❌ WHATSAPP_TOKEN / PHONE_NUMBER_ID missing.")
        print("   Copy .env.example to .env and fill them from Meta > API Setup.")
        sys.exit(1)

    url = f"https://graph.facebook.com/{VERSION}/{PHONE_NUMBER_ID}/messages"
    # First-contact must use an approved template. "hello_world" is pre-approved
    # on every new WhatsApp app, so this always works as a connection test.
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "template",
        "template": {"name": "hello_world", "language": {"code": "en_US"}},
    }
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

    resp = requests.post(url, json=payload, headers=headers, timeout=15)
    if resp.status_code < 300:
        print("✅ Sent! Check your WhatsApp — agar message aaya to connection REAL hai. 🎉")
        print(resp.json())
    else:
        print(f"❌ Failed ({resp.status_code}):")
        print(resp.text)
        print("\nCommon fixes:")
        print(" - Token 24h me expire hota hai — Meta se fresh token lo.")
        print(" - Test mode me: apna number 'To' recipient list me add karo (API Setup page).")


if __name__ == "__main__":
    main()
