/* content.js — non-translated data (hospital bag checklist).
 * NOTE: Week-by-week content and symptom names now come from i18n
 * (keys W4_SIZE..W42_NOTE and sym_*). See js/i18n/.
 * The checklist below is not yet translated — a to-do for later. */

window.DEFAULT_CHECKLIST = [
  { group: "For mother", items: [
    "ID and papers (Aadhaar, hospital card)", "Nighties (2-3)", "Maternity pads",
    "Toiletries", "Slippers", "Phone and charger", "Water bottle", "Snacks"] },
  { group: "For baby", items: [
    "Baby clothes (2-3 sets)", "Swaddle or wrapper", "Diapers", "Baby wipes",
    "Baby blanket", "Mittens and socks"] },
  { group: "Important documents", items: [
    "All scan reports", "Blood test reports", "Doctor's prescriptions", "Insurance card"] }
];
