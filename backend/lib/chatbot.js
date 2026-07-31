const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getSiteContent } = require("./siteContent");
const { getSettings } = require("./settings");

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.GEMINI_API_KEY) return null;
  client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
}

/**
 * Builds the chatbot's knowledge from whatever is CURRENTLY in the
 * database — no caching, no baked-in snapshot. Every new FAQ, review,
 * recommendation, or price change the owner adds via the dashboard is
 * reflected the very next time a guest asks a question.
 */
async function buildSystemContext() {
  const [siteContent, settings] = await Promise.all([getSiteContent(), getSettings()]);

  const unitBlocks = (settings.units || []).map(u => `
${u.name}:
- ${u.bedrooms || "?"} bedroom(s), ${u.bathrooms || "?"} bathroom(s), sleeps up to ${u.sleeps || "?"}
- Rate: R${u.pricePerNight} per night
- Amenities: ${(u.amenities || []).join(", ") || "not listed"}
- Description: ${u.description || ""}`).join("\n");

  const extrasBlock = (settings.extras || [])
    .map(e => `- ${e.label}: R${e.price}${e.type === "qty" ? " each" : ""}`)
    .join("\n") || "None currently listed.";

  const faqBlock = (siteContent.faqs || [])
    .map(f => `Q: ${f.question}\nA: ${f.answer}`)
    .join("\n\n") || "None added yet.";

  const recsBlock = (siteContent.recommendations || [])
    .map(r => `- ${r.name}${r.category ? ` (${r.category})` : ""}${r.distance ? `, ${r.distance}` : ""}: ${r.description || ""}`)
    .join("\n") || "None added yet.";

  const reviewsBlock = (siteContent.reviews || []).slice(0, 5)
    .map(r => `"${r.text}" — ${r.name} (${r.rating}/5)`)
    .join("\n") || "None yet.";

  return `You are the friendly virtual assistant for Welverdiend Accommodation, a two-unit self-catering guesthouse at 4 Kenilworth Road, Bloemfontein, South Africa.

ABOUT THE PROPERTY:
${(siteContent.aboutParagraphs || []).join("\n\n")}

THE UNITS:
${unitBlocks}

EXTRAS AVAILABLE WHEN BOOKING:
${extrasBlock}

FREQUENTLY ASKED QUESTIONS:
${faqBlock}

OUR OWN RECOMMENDATIONS NEARBY:
${recsBlock}

WHAT GUESTS HAVE SAID:
${reviewsBlock}

CONTACT: bookings@welverdiendaccommodation.com, 079 118 3173 (also on WhatsApp).
To check real availability or book, guests should use the live booking calendar at /booking-widget.html — never guess or state specific available dates yourself.

HOW TO ANSWER:
- Be warm, concise, and helpful.
- Answer ONLY using the information above. This is a hard rule, not a
  suggestion: if a specific fact — a time, a price, a policy detail —
  is not explicitly written above, you do NOT know it. Do not fill the
  gap with what's typical or common for guesthouses in general. A
  plausible-sounding invented answer is worse than admitting you don't
  know, even for small, ordinary-seeming details like check-in time.
- If the FAQs above already contain a relevant answer, use that answer
  as given — don't "improve" on it or add specifics it doesn't include.
- If you don't have an exact answer to something, say so plainly and
  direct the guest to WhatsApp or the contact page — don't guess, even
  a reasonable-sounding guess.

EXAMPLE OF CORRECT BEHAVIOR — a guest asks something with no exact
answer in the information above:
  Guest: "What time is check-in?"
  If no exact check-in time appears anywhere above, the correct answer
  is exactly this shape: "I don't have an exact check-in time listed —
  please message us on WhatsApp (079 118 3173) or use the contact page
  and we'll confirm it for you." NOT a specific time like "3:00 PM" —
  that would be invented, even though it sounds like a normal,
  reasonable guesthouse check-in time.

- If asked about live/current information you don't have — today's
  weather, what's on this weekend, current traffic — say plainly that
  you don't have real-time information, and suggest they search online
  or message the host directly on WhatsApp.
- If a question is about booking or exact availability, direct them to
  the live booking calendar rather than answering yourself.`;
}

async function askChatbot(message, history) {
  const genAI = getClient();
  if (!genAI) {
    return { ok: false, error: "Chat isn't set up yet — the site owner needs to add a Gemini API key." };
  }

  try {
    const systemInstruction = await buildSystemContext();
    const model = genAI.getGenerativeModel({
      model: "gemini-flash-lite-latest",
      systemInstruction,
      generationConfig: { maxOutputTokens: 400, temperature: 0.2 }
    });

    const chatHistory = (history || []).slice(-10).map(h => ({
      role: h.role === "bot" ? "model" : "user",
      parts: [{ text: String(h.text || "").slice(0, 1000) }]
    }));

    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(String(message).slice(0, 1000));
    return { ok: true, reply: result.response.text() };
  } catch (err) {
    console.error("[chatbot] request failed:", err.message);
    return { ok: false, error: "Something went wrong answering that — please try again, or message us on WhatsApp." };
  }
}

module.exports = { askChatbot };
