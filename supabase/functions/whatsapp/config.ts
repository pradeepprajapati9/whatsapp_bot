/**
 * config.ts — one business's front-desk details.
 *
 * Same shape as the Python MVP's config.json (configs/clinic.json is the
 * active one). Kept as a TS module so the Edge Function bundle needs no JSON
 * import assertions. To serve a second business, move this into a `businesses`
 * table and look it up by the phone_number_id the webhook arrived on.
 */

export interface CatalogItem {
  name?: string;
  item?: string;
  price?: number;
}

export interface BizConfig {
  business_name: string;
  business_type?: string;
  greeting?: string;
  timing?: string;
  address?: string;
  phone?: string;
  payment?: string;
  delivery?: string;
  closing_line?: string;
  order_instructions?: string;
  owner_wa?: string;
  services?: CatalogItem[];
  menu?: CatalogItem[];
  menu_rows?: Array<{ id: string; title: string }>;
  booking?: {
    enabled?: boolean;
    label?: string;
    ask_name?: string;
    ask_service?: string;
    ask_time?: string;
    confirm_note?: string;
  };
}

export const CONFIG: BizConfig = {
  business_name: "City Care Clinic",
  business_type: "clinic",

  greeting:
    "Namaste ji! 🙏 {business_name} me aapka swagat hai. Main appointment book karne aur aapke sawaalon me madad karunga.",

  timing: "🕒 OPD timing: *Mon–Sat 10:00 AM – 7:00 PM*. Sunday closed.",

  address:
    "📍 Hamara pata: City Care Clinic, Near Bus Stand, Sector 12, Gurgaon.\nGoogle Maps: https://maps.google.com/?q=City+Care+Clinic",

  phone: "📞 Call/WhatsApp: +91-98765-43210",

  payment: "💳 Payment: Cash, UPI (citycare@upi), Card — sab chalta hai.",

  services: [
    { name: "General Consultation (Physician)", price: 300 },
    { name: "Skin & Hair Consultation", price: 500 },
    { name: "Dental Checkup", price: 400 },
    { name: "Child Specialist (Pediatric)", price: 400 },
    { name: "Blood Test / Lab Sample", price: 200 },
  ],

  booking: {
    enabled: true,
    label: "appointment",
    ask_name: "Zaroor! 📅 Appointment ke liye — aapka *naam* bataiye 🙂",
    ask_service:
      "Kis ke liye appointment chahiye? Neeche list se *number* ya naam bhejein:",
    ask_time:
      "Kis *din aur time* aana chahenge? (jaise: 'Kal shaam 5 baje' ya 'Monday morning')",
    confirm_note:
      "Hamara staff aapko thodi der me call karke appointment *confirm* karega. 🙏",
  },

  closing_line: "Appointment ke liye *appointment* likhein 👇",

  owner_wa: "",
};
