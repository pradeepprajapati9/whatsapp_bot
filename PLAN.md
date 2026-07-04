# WhatsApp Business Bot — Business + Technical Plan 💬

> Goal: ek **multi-tenant SaaS** jisme koi bhi local business apna WhatsApp number
> connect kare, apna menu/price/timing daale, aur bot khud customers ko reply kare +
> orders/leads capture kare. Monthly recurring revenue.
>
> **Reuse:** yeh `youtube_bot` ke Supabase + worker + dashboard pattern ka clone hai.
> Naya sirf: WhatsApp webhook (instant reply) + reply engine (already bana hua `bot.py`).

---

## 1. Business plan (India-focused)

### Target customer (pehle 3 niches, phir expand)
| Niche | Kyun perfect |
|-------|--------------|
| 🍽️ Restaurants / cloud kitchens | Menu + price + order — daily repeat queries |
| 💇 Salons / clinics | Appointment timing + services + booking |
| 🛍️ Boutiques / kirana-with-delivery | Catalog + "available hai?" + order |

Sab already WhatsApp pe hain, par manually reply karte hain → yahi pain hum solve karte hain.

### Kyun ye idea jeet-ta hai
- **Demand zabardast, competition kam** — India me har chhota business WhatsApp pe hai.
- **Free replies** — inbound customer ko reply (24h service window me) Meta pe **free** hota hai.
  Cost sirf broadcasts/marketing pe. Matlab core product ka running cost ~₹0.
- **SaaS recurring** — ek baar setup, har mahine paisa.
- **Sticky** — number + orders + customers ka data hamare paas → churn kam.

### Pricing (monthly, INR)
| Plan | ₹/mo | Kya milta |
|------|------|-----------|
| **Starter** | 299 | 1 number, auto-reply (menu/price/timing/address), 1 dashboard user |
| **Pro** | 799 | + order/lead capture, order notification owner ko, 100 broadcast msg/mo, analytics |
| **Business** | 1,999 | + multi-location/number, AI reply add-on, unlimited staff, priority |

- 7-din free trial (test number pe).
- Setup fee optional ₹499–999 (number connect + config karke dena — "done-for-you").

### Revenue math (realistic)
- 50 paying shops × avg ₹700 = **₹35,000/mo** recurring, running cost lagbhag zero.
- 200 shops = ₹1.4L/mo. Solo-run possible kyunki setup automated hai.

### Go-to-market
1. Ek niche pakdo (bolo local restaurants), 5 ko **free me** setup karke do → testimonials + demo videos.
2. Demo: apne phone se unke bot ko "menu?" bhejo, instant reply dikhao. Yehi sabse strong pitch hai.
3. Instagram/YouTube Shorts me "before/after" (owner khud reply kar raha vs bot). Tumhara youtube_bot content banane me already expert hai — usi se leads.
4. Referral: ek shop laaye to ek mahina free.

### Moat
- Customer data + order history hamare paas.
- Per-niche pre-built templates (restaurant config vs salon config) → naya client 5 min me live.
- AI upsell (Pro→Business) baad me.

---

## 2. Technical plan (tumhare stack pe)

### Architecture (youtube_bot ka mirror + WhatsApp webhook)

```
Customer WhatsApp
      │  (message aaya)
      ▼
Meta Cloud API  ──webhook POST──►  Supabase EDGE FUNCTION  ◄── always-on, free, instant
                                        │   1. business config padho (Supabase se)
                                        │   2. reply banao (bot.py ki logic, TS me)
                                        │   3. order/lead? -> jobs/orders table me insert
                                        │   4. Cloud API se reply bhejo
                                        ▼
                                   Supabase DB (RLS multi-tenant)
                                        ▲                 ▲
                                        │                 │
                        Web Dashboard (owner)      GitHub Actions WORKER (cron)
                        - menu/timing edit          - broadcasts bhejo
                        - orders/leads dekho        - follow-up nudges
                        - number connect            - daily order summary owner ko
```

**Kya reuse ho raha (youtube_bot se):**
- Supabase project + Auth + RLS pattern → **as-is**.
- `channel_tokens` jaisa secret table → yahan `wa_credentials` (har shop ka Cloud API token, client-locked).
- Web dashboard (static HTML + Supabase JS) → menu/order UI me badal do.
- GitHub Actions worker.yml → broadcast/summary worker me badal do.

**Naya kya banega:**
- **Supabase Edge Function** = WhatsApp webhook (yeh `youtube_bot` me nahi tha; WhatsApp ko instant reply chahiye isliye cron nahi chalega).
- Reply engine — `whatsapp_bot/bot.py` ki keyword logic already ready; Edge Function (Deno/TS) me port kar denge (~50 lines, simple hai).

> **Webhook host decision:** Edge Function chuna kyunki Render/Railway ke free tier
> so jaate hain (cold start = late reply = WhatsApp pe bura). Edge Function serverless +
> free + instant. Reply logic itni simple hai ki TS port trivial hai.

### Data model (Supabase tables)
```
businesses      (id, owner_uid, name, timing, address, delivery, payment, active_plan)
menu_items      (id, business_id, item, price, available)
wa_credentials  (business_id, phone_number_id, access_token)   -- SECRET, RLS client-locked
conversations   (id, business_id, customer_wa, last_msg, updated_at)
orders          (id, business_id, customer_wa, items_text, status, created_at)
broadcasts      (id, business_id, template, status, scheduled_at)  -- worker processes
```
RLS: har owner sirf apne `business_id` ke rows dekhe (youtube_bot jaisa exactly).

### MVP scope (2 hafta, weekend-buildable)
**Week 1 — core loop live:**
1. Supabase project + schema + RLS.
2. Edge Function webhook: receive → reply (menu/price/timing/address) → done.
3. `bot.py` logic port to TS.
4. Ek real shop ke test number pe end-to-end reply working.

**Week 2 — SaaS shell:**
5. Web dashboard: login, menu/timing edit, "connect number" flow.
6. Order/lead capture → dashboard me dikhe + owner ko WhatsApp notification.
7. GitHub Actions worker: daily order summary + broadcast sender.

**Baad me (v2):** AI reply add-on (Claude, sirf Pro/Business), appointment booking, payment link, analytics.

---

## 3. Risks / dhyan dene layak
- **Meta setup friction** — har shop ko business number + verification chahiye. Solution: "done-for-you" onboarding (setup fee), ya BSP (Business Solution Provider) ke through aggregate.
- **Template message approval** — broadcasts ke liye Meta template approve karta hai (24-48h). Utility templates aasani se pass hote hain.
- **Number ban** — sirf official Cloud API use karenge (QR/unofficial kabhi nahi) → safe.
- **Spam limits** — naye number pe rozana msg limit hota hai (tier system); genuine use se auto-badhta hai.

---

## 4. Status / next step

**✅ Ho gaya (local, single-business MVP):**
- Reply engine (`bot.py`) — FAQ + **multi-step appointment/booking flow** (naam → service → time → save).
- **Front-desk pivot** — clinic ko primary niche banaya (research recommendation). Multi-niche configs:
  `configs/clinic.json`, `configs/salon.json`, `configs/restaurant.json`.
- **Lead capture** (`store.py`) → `appointments.json` me save, **DPDP-safe** (sirf naam/phone/service/time).
- Owner ko nayi booking ka WhatsApp alert (`app.py` → `notify_owner`).
- Flask webhook (Cloud API) ready; `test_bot.py` se bina Meta setup ke sab test ho jata hai.

**⏭️ Next (jab pehla real client mile):**
1. Meta Cloud API pe live jana (permanent token + stable HTTPS host) — README me steps.
2. **Multi-tenant** — Supabase schema + Edge Function webhook + per-business config (upar section 2).
   Abhi single-business hai; SaaS banane ke liye yahi step hai.
3. Simple owner dashboard (appointments dekhe/manage kare).
```
