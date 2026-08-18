# Supabase pe deploy (permanent, ₹0)

Bot ab Render se hatke **Supabase Edge Function** pe chalega.

**Kyun:** Render free plan me 750 instance-hours/month milte hain. Ek service ko 24/7
chalane me hi ~744 hrs lag jaate hain — isliye service har mahine suspend ho jaati thi
("Free usage limit reached"). Supabase Edge Functions me hours ki limit nahi hai, service
sleep bhi nahi hoti (Render ka 50s cold-start delay bhi khatam), aur free plan me
500k calls/month milte hain. Bonus: appointments ab Postgres me save honge —
`appointments.json` har redeploy pe udd jaata tha.

Purani Flask files (`app.py`, `bot.py`, `store.py`) **delete nahi ki** — offline testing
(`test_bot.py`) aur reference ke liye rakhi hain. Live traffic sirf Edge Function handle karega.

---

## Step 1 — Supabase project banao

1. https://supabase.com pe sign up / login karo (free, card nahi maangta).
2. **New project** → naam `whatsapp-frontdesk-bot`, region **South Asia (Mumbai)**,
   database password kahin note kar lo.
3. Project ban jaane ke baad **Project Settings → General** me se **Reference ID**
   copy karo (aisa dikhta hai: `abcdefghijklmnop`). Isko neeche `<REF>` bola gaya hai.

## Step 2 — Tables banao

Dashboard me **SQL Editor** kholo → **New query** → `supabase/migrations/0001_init.sql`
ka poora content paste karo → **Run**.

Do tables banenge: `sessions` (booking ka step yaad rakhne ke liye) aur `appointments`
(saved leads).

## Step 3 — CLI login + link

Terminal me `whatsapp_bot` folder ke andar:

```bash
npx supabase login                 # browser khulega, allow kar dena
npx supabase link --project-ref <REF>
```

## Step 4 — Secrets set karo

Token wahi permanent System User token hai jo abhi Render me pada hai
(Render dashboard → service → Environment se copy kar lo). `OWNER_WA` = owner ka
WhatsApp number, `91` + number, bina `+` ke — wo bhi wahin Environment me hai.

```bash
npx supabase secrets set \
  WHATSAPP_TOKEN=<render_wala_token> \
  PHONE_NUMBER_ID=1272030682651780 \
  VERIFY_TOKEN=citycare_verify_2026 \
  OWNER_WA=<owner_ka_whatsapp_number> \
  GRAPH_API_VERSION=v21.0
```

`SUPABASE_URL` aur `SUPABASE_SERVICE_ROLE_KEY` khud-ba-khud milte hain — wo set mat karna.

## Step 5 — Function deploy karo

```bash
npx supabase functions deploy whatsapp --no-verify-jwt
```

`--no-verify-jwt` **zaroori** hai — Meta bina Supabase JWT ke call karta hai, warna 401 milega.

Deploy ke baad URL ye hoga:

```
https://<REF>.supabase.co/functions/v1/whatsapp
```

Browser me kholo — `City Care Clinic WhatsApp bot is running ✅` aana chahiye.

## Step 6 — Meta me webhook badlo

> ⚠️ Office WiFi Meta/Graph API block karta hai — ye step **phone hotspot** pe karna.

1. https://developers.facebook.com → app **FrontDesk Bot** → **WhatsApp → Configuration**
2. **Callback URL** = `https://<REF>.supabase.co/functions/v1/whatsapp`
3. **Verify token** = `citycare_verify_2026` (wahi purana)
4. **Verify and save** → green tick aana chahiye
5. Neeche **Webhook fields** me `messages` subscribed hai ye confirm karo

## Step 7 — Test

Apne WhatsApp se test number (+1 555 629-2046) pe `hi` bhejo → menu aana chahiye.
Fir `appointment` → naam → service number → time. Aakhir me:

- Customer ko confirmation message
- Owner (`OWNER_WA`) ko booking alert
- Supabase → **Table Editor → appointments** me row dikhni chahiye

Kuch na aaye to Supabase dashboard → **Edge Functions → whatsapp → Logs** dekho.

## Step 8 — Render band karo

Sab chalne ke baad Render ka `whatsapp-frontdesk-bot` service **delete/suspend** kar do,
taaki free hours featherbyte (live Shopify app) ke liye bache.

---

## Rozana ka kaam

- **Config badalna** (services, price, timing, address): `supabase/functions/whatsapp/config.ts`
  edit karo, phir `npx supabase functions deploy whatsapp --no-verify-jwt`.
- **Leads dekhna**: Supabase → Table Editor → `appointments`.
- **Doosra business add karna**: `config.ts` ko `businesses` table me le jao aur
  webhook me aaye `phone_number_id` se lookup karo (PLAN.md ka multi-tenant step).

## Abhi bhi pending (pehle jaisa)

Bot abhi bhi Meta ke **test number** pe hai, jo sirf pre-verified numbers ko message
kar sakta hai. Asli client ke liye uska apna WhatsApp number register karna + Business
Verification karna padega. Ye hosting se alag cheez hai — Supabase pe shift hone se
ye requirement nahi badalti.
