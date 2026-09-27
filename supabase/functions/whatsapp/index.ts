/**
 * index.ts — WhatsApp Cloud API webhook, as a Supabase Edge Function.
 *
 * Port of the Flask app.py. Same two behaviours on the same path:
 *   GET  -> Meta's verification handshake (echoes hub.challenge)
 *   POST -> incoming customer messages; we reply via the Graph API
 *
 * Why this exists: the Flask version ran on Render's free tier, whose 750
 * instance-hours/month cannot keep a service up 24/7 alongside anything else.
 * Supabase Edge Functions have no hour budget and never sleep, so the bot stays
 * reachable — which is the whole job of a webhook.
 *
 * Deploy: see DEPLOY_SUPABASE.md (must be deployed with --no-verify-jwt,
 * because Meta calls this without a Supabase JWT).
 */

import { CONFIG } from "./config.ts";
import { buildReply, menuRows, shouldOfferMenu, type Session } from "./bot.ts";
import {
  getPatientLang,
  getSession,
  saveAppointment,
  savePatient,
  saveSession,
  takenBands,
} from "./store.ts";

// --- Credentials from secrets (never hard-code tokens) ----------------------
const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN") ?? "my_verify_token";
const ACCESS_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const PHONE_NUMBER_ID = Deno.env.get("PHONE_NUMBER_ID") ?? "";
const GRAPH_API_VERSION = Deno.env.get("GRAPH_API_VERSION") ?? "v21.0";
// Owner's WhatsApp number (country code, no +) for new-booking alerts.
const OWNER_WA = Deno.env.get("OWNER_WA") || CONFIG.owner_wa || "";

const GRAPH_URL = "https://graph.facebook.com/" + GRAPH_API_VERSION + "/" +
  PHONE_NUMBER_ID + "/messages";

/** The customer's typed text, or the id of a tapped menu row/button (WhatsApp
 *  sends taps as an 'interactive' message, not plain text). */
function incomingText(msg: Record<string, any>): string {
  if (msg.type === "interactive") {
    const inter = msg.interactive ?? {};
    const chosen = inter.list_reply ?? inter.button_reply ?? {};
    return chosen.id ?? "";
  }
  return msg.text?.body ?? "";
}

function graphHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer " + ACCESS_TOKEN,
    "Content-Type": "application/json",
  };
}

/** Send a text message back to the customer via the Cloud API. */
async function sendMessage(to: string, body: string): Promise<void> {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.log("[DRY RUN] would send to " + to + ":\n" + body);
    return;
  }
  const resp = await fetch(GRAPH_URL, {
    method: "POST",
    headers: graphHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!resp.ok) console.error("[send error " + resp.status + "]", await resp.text());
}

/** Send the reply text together with a tappable option list, so the customer
 *  can pick 'Services', 'Book appointment', etc. instead of typing it. */
async function sendMenu(to: string, body: string): Promise<void> {
  const rows = menuRows(CONFIG);
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.log("[DRY RUN] menu to " + to + ":\n" + body + "\n  rows=" + rows.map((r) => r[0]));
    return;
  }
  const resp = await fetch(GRAPH_URL, {
    method: "POST",
    headers: graphHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body.slice(0, 1024) },
        action: {
          button: "Menu ▾",
          sections: [{
            title: "How can I help?",
            rows: rows.map(([id, title]) => ({ id, title: title.slice(0, 24) })),
          }],
        },
      },
    }),
  });
  if (!resp.ok) {
    console.error("[menu send error " + resp.status + "]", await resp.text());
    await sendMessage(to, body); // fallback so the customer still gets a reply
  }
}

/**
 * Ping the business owner about a new booking/lead.
 *
 * Note: a proactive message to the owner works only if the owner messaged the
 * number in the last 24h; otherwise Meta requires an approved template. The
 * lead is always saved in the appointments table as the reliable record.
 */
async function notifyOwner(record: Record<string, string>): Promise<void> {
  if (!OWNER_WA) return;
  await sendMessage(
    OWNER_WA,
    "🔔 *Nayi booking!*\n" +
      "👤 " + record.name + "  (📞 " + record.phone + ")\n" +
      "🩺 " + record.service + "\n" +
      "🕒 " + record.time,
  );
}

/** Handle one incoming customer message and reply. */
async function handleIncoming(data: Record<string, any>): Promise<void> {
  const value = data?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  // No message = a status update (delivered/read) or an unexpected payload.
  if (!msg) return;

  const sender: string = msg.from; // customer's WhatsApp number
  const text = incomingText(msg); // plain text OR a tapped menu id

  const session: Session = await getSession(sender);
  const offerMenu = shouldOfferMenu(text, session);

  // What language did this number choose last time? A returning patient is
  // never asked again - and the reminder that goes out tomorrow has to be in
  // the same language, or it may as well not be sent.
  const knownLang = (await getPatientLang(sender)) as
    ("hinglish" | "hindi" | "english" | null);

  const reply = await buildReply(
    text, CONFIG, session, offerMenu, saveAppointment,
    knownLang ?? undefined, takenBands,
  );

  // If they picked a language in this message, remember it for good.
  if (session.lang && session.lang !== knownLang) {
    await savePatient(sender, session.lang, session.data?.name,
                      CONFIG.business_name ?? "");
  }

  if (offerMenu && !session.flow) {
    await sendMenu(sender, reply); // reply + tappable option list
  } else {
    await sendMessage(sender, reply);
  }

  const booked = session._booked;
  delete session._booked;
  await saveSession(sender, session);

  // If a booking just completed, alert the business owner.
  if (booked) await notifyOwner(booked);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Meta calls this once when you register the webhook.
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    // Anything else on GET is a health check.
    if (!url.searchParams.has("hub.mode")) {
      return new Response(CONFIG.business_name + " WhatsApp bot is running ✅", { status: 200 });
    }
    return new Response("Verification failed", { status: 403 });
  }

  if (req.method === "POST") {
    try {
      await handleIncoming(await req.json());
    } catch (err) {
      // Always acknowledge, otherwise Meta retries the same message for hours.
      console.error("[webhook]", err);
    }
    return new Response("ok", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});
