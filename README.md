# WhatsApp Front-Desk Bot 💬

Har local business (**clinic, salon, coaching, restaurant**) ka WhatsApp khud customer ko
reply kare **aur appointment/order book kare** — 24x7, free.

- **📅 Appointment / lead capture** — bot naam → service → time poochta hai aur lead
  `appointments.json` me save karta hai. Yahi asli paisa wala feature (business ko naye customer).
- **Free replies** — rule/keyword based, no AI cost per message. Inbound reply Meta pe free.
- **Ban-safe** — official WhatsApp Cloud API (Meta), not a QR hack. Safe to sell to real shops.
- **Reusable** — one config per business (`config.json` + `configs/` me clinic/salon/restaurant examples). Naya client = naya config, code same.
- **Hinglish** — customers "kitne ka hai", "appointment chahiye" jaise messages bhejein, bot samajh jaata hai.
- **⚖️ DPDP-safe** — bot sirf naam/phone/service/time leta hai; **medical/sensitive data kabhi nahi** (India DPDP Act 2023 ke hisaab se safe).

---

## Files

| File | Kya karta hai |
|------|----------------|
| `bot.py` | Reply engine (keyword → answer) + multi-step **appointment/booking flow**. WhatsApp-independent. |
| `app.py` | Flask webhook — Meta se messages leta hai, reply bhejta hai, owner ko booking alert. |
| `store.py` | Booking/lead ko `appointments.json` me save karta hai (DPDP-safe: non-sensitive data only). |
| `config.json` | Active business ki info (services/menu, price, timing, booking...). **Yahi edit karo per client.** |
| `configs/` | Ready examples: `clinic.json`, `salon.json`, `restaurant.json`. Kisi ko copy karke `config.json` bana lo. |
| `test_bot.py` | Bina kisi setup ke bot test karo (FAQ + booking). `--config configs/salon.json` se dusra business. |
| `.env.example` | Secret tokens ka template. |
| `requirements.txt` | Python dependencies. |

---

## 1. Install & test locally (no WhatsApp needed)

```bash
pip install -r requirements.txt

python test_bot.py          # sample conversation
python test_bot.py --chat   # apne messages type karke test karo
```

Isse pehle confirm ho jaata hai ki replies sahi hain. Meta ka koi setup nahi chahiye.

---

## 2. Customize for a business

Bas `config.json` edit karo — koi code touch nahi:
- **Clinic/salon** → `services` list (name + price) + `booking` (label `"appointment"`).
- **Restaurant/shop** → `menu` list (item + price) + `booking` (label `"order"`).
- Common: `business_name`, `greeting`, `timing`, `address`, `phone`, `payment`, `owner_wa` (owner ko booking alert).

Naye client ke liye sabse fast: `configs/` me se milta-julta example (`clinic.json`/`salon.json`/`restaurant.json`)
copy karke `config.json` bana lo, details badlo — bot ready (5 min me naya client live).

> **⚖️ DPDP note:** booking me sirf naam/service/time poochho. Symptoms, bimari, report jaisi
> medical/sensitive info kabhi mat maango — bot isi liye aisa bana hai. Ye tumhe India ke
> DPDP Act 2023 ke bhaari compliance se bachaata hai.

---

## 3. Go live with WhatsApp Cloud API (free)

1. **Meta setup**
   - <https://developers.facebook.com> → *Create App* → type **Business**.
   - Add product **WhatsApp**. Ek test number free milta hai.
   - *API Setup* page se copy karo: **Temporary access token** aur **Phone number ID**.

2. **Env vars bharo** — `.env.example` ko `.env` bana ke values daalo
   (`VERIFY_TOKEN` apni marzi ka koi string, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`).

3. **App chalao aur public karo** (Meta ko HTTPS URL chahiye):
   ```bash
   # env vars load karo, phir:
   python app.py
   # dusre terminal me:
   ngrok http 5000        # https URL milega
   ```

4. **Webhook register karo** (Meta → WhatsApp → Configuration):
   - Callback URL: `https://<ngrok-url>/webhook`
   - Verify token: wahi jo `.env` me `VERIFY_TOKEN` rakha.
   - Subscribe field: **messages**.

5. Apne phone se test number pe "hi" bhejo → bot reply karega. ✅

> **Note:** Meta ka *temporary* token 24 ghante me expire hota hai. Production ke liye
> System User ka **permanent token** banao. Customer ke reply (24h window me) **free** hote hain.

---

## Production (optional)

`python app.py` sirf dev ke liye hai. Live server pe:

```bash
pip install gunicorn
gunicorn -w 2 -b 0.0.0.0:5000 app:app
```

Ek proper host (Render/Railway/VPS) use karo taaki HTTPS URL stable rahe — ngrok
har baar URL badalta hai.

---

## Naye intents / replies add karna

`bot.py` ke `INTENTS` dict me keyword add karo, `build_reply()` me uska jawab.
Multi-word keyword (jaise `"kitne baje"`) substring se match hota hai; single word
whole-word se. Ambiguous words (jaise `kitne`) ke liye zyada specific intent ko
`INTENTS` me pehle rakho.
```
