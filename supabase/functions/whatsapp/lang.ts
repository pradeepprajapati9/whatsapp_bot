/**
 * lang.ts — every sentence the bot says, in three languages.
 *
 * WHY THE LANGUAGE IS ASKED ONCE AND THEN REMEMBERED
 *
 * A reminder arrives a day after the conversation ended. If it turns up in a
 * script the patient cannot read, it is not a reminder — it is noise, and they
 * no-show anyway. The whole point of the product dies on that one detail.
 *
 * So the choice is stored on the patient row, not the session, and every later
 * message — reminder, nudge, follow-up — is written in it. A patient is asked
 * exactly once, ever.
 *
 * WHY THREE AND NOT TWO
 *
 * Hinglish is not a compromise between Hindi and English, it is what most urban
 * Indian patients actually read fastest. But an older or rural patient may want
 * real Devanagari, and an English-medium one finds Hinglish clumsy to read. All
 * three are real audiences, not variations of one.
 */

export type Lang = "hinglish" | "hindi" | "english";

export const LANGS: Lang[] = ["hinglish", "hindi", "english"];

/** The one question asked before anything else. Deliberately shown in all three
 *  scripts at once, so whoever is reading recognises their own. */
export const LANGUAGE_PROMPT =
  "🙏 Namaste! Aap kis bhasha me baat karna chahenge?\n" +
  "आप किस भाषा में बात करना चाहेंगे?\n" +
  "Which language would you prefer?\n\n" +
  "1️⃣  Hinglish  (Hindi + English)\n" +
  "2️⃣  हिंदी\n" +
  "3️⃣  English";

/** Read a language out of whatever the patient replied. */
export function detectLang(text: string): Lang | null {
  const t = (text || "").toLowerCase().trim();
  if (/^1\b|hinglish/.test(t)) return "hinglish";
  if (/^2\b|hindi|हिंदी|हिन्दी/.test(t)) return "hindi";
  if (/^3\b|english|angrezi|अंग्रेज़ी/.test(t)) return "english";
  // Written in Devanagari at all? Then Hindi is the safe assumption.
  if (/[ऀ-ॿ]/.test(text || "")) return "hindi";
  return null;
}

type Dict = Record<Lang, string>;

const T: Record<string, Dict> = {
  lang_set: {
    hinglish: "Theek hai 👍 Ab main Hinglish me baat karunga.",
    hindi: "ठीक है 👍 अब मैं हिंदी में बात करूँगा।",
    english: "Got it 👍 I will continue in English.",
  },
  ask_name: {
    hinglish: "Aapka *naam* bataiye 🙂",
    hindi: "अपना *नाम* बताइए 🙂",
    english: "May I have your *name*? 🙂",
  },
  ask_service: {
    hinglish: "Kis ke liye appointment chahiye? Number bhejein:",
    hindi: "किसके लिए अपॉइंटमेंट चाहिए? नंबर भेजें:",
    english: "What do you need an appointment for? Send the number:",
  },
  ask_time: {
    hinglish: "Kis *din aur time* aana chahenge?\n(jaise: 'kal shaam 5 baje')",
    hindi: "किस *दिन और समय* आना चाहेंगे?\n(जैसे: 'कल शाम ५ बजे')",
    english: "Which *day and time* would suit you?\n(e.g. 'tomorrow 5 pm')",
  },
  // Asked whenever the parser was not certain. Cheap to ask, expensive to skip:
  // a patient sent to the wrong hour blames the clinic, not the software.
  confirm_time: {
    hinglish: "Maine samjha: *{time}*\nSahi hai? *Haan* ya *Nahi* likhein.",
    hindi: "मैंने समझा: *{time}*\nसही है? *हाँ* या *नहीं* लिखें।",
    english: "I understood: *{time}*\nIs that right? Reply *Yes* or *No*.",
  },
  not_understood_time: {
    hinglish: "Time samajh nahi aaya 🙏 Aise likhein: 'kal shaam 5 baje'",
    hindi: "समय समझ नहीं आया 🙏 ऐसे लिखें: 'कल शाम ५ बजे'",
    english: "I did not catch the time 🙏 Try: 'tomorrow 5 pm'",
  },
  slot_taken: {
    hinglish: "{reason}\nYe time khali hain:\n{options}\n\nNumber bhejein:",
    hindi: "{reason}\nये समय खाली हैं:\n{options}\n\nनंबर भेजें:",
    english: "{reason}\nThese times are free:\n{options}\n\nSend the number:",
  },
  booked: {
    hinglish: "✅ Ho gaya!\n\n*{name}*\n{service}\n🗓️ {time}\n\n" +
              "Ek din pehle main yaad dila dunga 🙏",
    hindi: "✅ हो गया!\n\n*{name}*\n{service}\n🗓️ {time}\n\n" +
           "एक दिन पहले मैं याद दिला दूँगा 🙏",
    english: "✅ Booked!\n\n*{name}*\n{service}\n🗓️ {time}\n\n" +
             "I will remind you a day before 🙏",
  },
  // The reminder. Its job is NOT to remind - it is to force a yes or a no,
  // because a "no" a day early frees a slot that can still be sold, and a
  // no-show frees nothing.
  reminder: {
    hinglish: "🔔 Yaad dilane ke liye — kal aapka appointment hai:\n\n" +
              "🗓️ *{time}*\n{service}\n📍 {address}\n\n" +
              "Aa rahe hain?\n*1* = Haan   *2* = Nahi aa paunga   *3* = Time badalna hai",
    hindi: "🔔 याद दिलाने के लिए — कल आपका अपॉइंटमेंट है:\n\n" +
           "🗓️ *{time}*\n{service}\n📍 {address}\n\n" +
           "आ रहे हैं?\n*1* = हाँ   *2* = नहीं आ पाऊँगा   *3* = समय बदलना है",
    english: "🔔 A reminder — your appointment is tomorrow:\n\n" +
             "🗓️ *{time}*\n{service}\n📍 {address}\n\n" +
             "Will you be coming?\n*1* = Yes   *2* = Cannot make it   *3* = Need a different time",
  },
  confirmed_thanks: {
    hinglish: "Shukriya 🙏 Kal milte hain.",
    hindi: "शुक्रिया 🙏 कल मिलते हैं।",
    english: "Thank you 🙏 See you tomorrow.",
  },
  // Never make someone feel bad for cancelling. A patient who feels scolded
  // simply stops replying next time, and then you are back to no-shows.
  cancelled_thanks: {
    hinglish: "Theek hai, koi baat nahi 🙏 Batane ke liye shukriya.\n" +
              "Jab chahein, *appointment* likhkar naya time le lein.",
    hindi: "ठीक है, कोई बात नहीं 🙏 बताने के लिए शुक्रिया।\n" +
           "जब चाहें, *अपॉइंटमेंट* लिखकर नया समय ले लें।",
    english: "That is absolutely fine 🙏 Thank you for letting us know.\n" +
             "Whenever you are ready, just type *appointment* for a new time.",
  },
  nudge: {
    hinglish: "⏰ Aaj *{time}* aapka appointment hai.\n📍 {address}\n{maps}",
    hindi: "⏰ आज *{time}* आपका अपॉइंटमेंट है।\n📍 {address}\n{maps}",
    english: "⏰ Your appointment is today at *{time}*.\n📍 {address}\n{maps}",
  },
  opted_out: {
    hinglish: "Theek hai, ab main message nahi bhejunga 🙏",
    hindi: "ठीक है, अब मैं संदेश नहीं भेजूँगा 🙏",
    english: "Understood, I will not message again 🙏",
  },
};

/** A line in the patient's language, with {placeholders} filled in. */
export function t(key: string, lang: Lang, vars: Record<string, string> = {}): string {
  const entry = T[key];
  if (!entry) return "";
  let s = entry[lang] ?? entry.hinglish;
  for (const [k, v] of Object.entries(vars)) s = s.split("{" + k + "}").join(v);
  return s;
}

/** Yes / no, in any of the three languages, spoken or numbered. */
export function readYesNo(text: string): "yes" | "no" | "reschedule" | null {
  const t = (text || "").toLowerCase().trim();
  if (/^1\b|^y\b|yes|haan|han|ha\b|हाँ|हां|ok|okay|theek/.test(t)) return "yes";
  if (/^2\b|^n\b|\bno\b|nahi|nhi|नहीं|cancel|रद्द/.test(t)) return "no";
  if (/^3\b|change|badal|reschedule|बदल|dusra|another/.test(t)) return "reschedule";
  return null;
}
