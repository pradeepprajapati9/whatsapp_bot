"""
store.py — save captured appointments / leads locally (JSON file).

This is the "money" part of a front-desk bot: every booking a customer starts
becomes a saved lead the business can call back.

⚖️  DPDP-SAFE BY DESIGN (India's Digital Personal Data Protection Act, 2023):
    We store ONLY non-sensitive scheduling info — name, WhatsApp number, the
    chosen service category, and a preferred time. We NEVER ask for or store
    medical details (symptoms, diagnosis, reports, prescriptions). The booking
    flow is built so it cannot collect sensitive data. Keep it that way.

For the MVP this writes to a local appointments.json. Later this same function
is the one place to swap for a Supabase insert (see PLAN.md) — nothing else
changes.
"""

import json
from datetime import datetime
from pathlib import Path

APPTS_PATH = Path(__file__).with_name("appointments.json")


def save_appointment(record: dict) -> dict:
    """Append one appointment/lead to appointments.json and return it (with a
    server-side timestamp added). Safe if the file is missing or corrupt."""
    record = {**record, "created_at": datetime.now().isoformat(timespec="seconds")}
    data = load_appointments()
    data.append(record)
    with open(APPTS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return record


def load_appointments() -> list:
    """Read all saved appointments (empty list if none / unreadable)."""
    if not APPTS_PATH.exists():
        return []
    try:
        with open(APPTS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
