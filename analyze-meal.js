// Serverless functie op Vercel. Draait server-side, zodat de Anthropic-sleutel
// nooit in de browser terechtkomt.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://gcnrgrmmsajatoblhvfb.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_xJEAhbN_R2NOT7jutamerA_hJCZzvb_";

const PROMPT = `Je bent een voedingsdeskundige die een foto van een maaltijd beoordeelt.

Schat de voedingswaarde van wat er op de foto staat. Let op portiegrootte: gebruik
het bord, bestek of glas als maatstaf. Reken bereidingsvet mee als iets gebakken lijkt.
Bij twijfel schat je aan de voorzichtige kant hoog in plaats van laag, want mensen
onderschatten hun inname structureel.

Antwoord met UITSLUITEND geldige JSON, zonder markdown, zonder toelichting eromheen:
{
  "name": "korte Nederlandse naam, max 6 woorden",
  "calories": getal,
  "protein_g": getal,
  "carbs_g": getal,
  "fat_g": getal,
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack",
  "confidence": "low" | "medium" | "high",
  "notes": "één korte zin over wat je onzeker maakt, of leeg"
}

Staat er geen eten op de foto, gebruik dan calories 0, confidence "low" en zet in
notes dat je geen maaltijd herkent.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Alleen POST." });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Serversleutel ontbreekt." });
  }

  // Alleen ingelogde gebruikers, anders kan iedereen je API-tegoed opmaken.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Niet ingelogd." });

  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY },
    });
    if (!who.ok) return res.status(401).json({ error: "Sessie verlopen. Log opnieuw in." });
  } catch {
    return res.status(503).json({ error: "Kon je sessie niet controleren." });
  }

  const image = req.body?.image;
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "Geen afbeelding meegestuurd." });
  }
  // Ruwweg 6 MB aan base64; de client verkleint al naar ~1024px.
  if (image.length > 8_000_000) {
    return res.status(413).json({ error: "Afbeelding te groot." });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("Anthropic error", upstream.status, detail);

      // Eén vage melding voor alles maakte een kapotte configuratie
      // ononderscheidbaar van een slechte foto. Dat kost dagen zoeken.
      const uitleg = {
        400: "Het verzoek werd geweigerd. Waarschijnlijk klopt de modelnaam of de opmaak niet.",
        401: "De API-sleutel wordt niet geaccepteerd. Controleer ANTHROPIC_API_KEY.",
        403: "Geen toegang met deze sleutel.",
        404: "Dit model bestaat niet onder deze naam.",
        413: "De foto is te groot voor de API.",
        429: "Te veel verzoeken achter elkaar. Wacht even.",
        529: "De API is overbelast. Probeer het zo nog eens.",
      }[upstream.status];

      return res.status(502).json({
        error: uitleg || `De analyse gaf geen antwoord (status ${upstream.status}).`,
      });
    }

    const data = await upstream.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const parsed = parseJson(text);
    if (!parsed) return res.status(502).json({ error: "Antwoord was niet leesbaar." });

    return res.status(200).json({
      name: String(parsed.name || "Maaltijd").slice(0, 80),
      calories: num(parsed.calories),
      protein_g: num(parsed.protein_g),
      carbs_g: num(parsed.carbs_g),
      fat_g: num(parsed.fat_g),
      meal_type: ["breakfast", "lunch", "dinner", "snack"].includes(parsed.meal_type)
        ? parsed.meal_type
        : guessMealType(),
      confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low",
      notes: String(parsed.notes || "").slice(0, 200),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Analyse mislukt." });
  }
};

function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
};

function guessMealType() {
  const h = new Date().getUTCHours() + 2; // ruwe NL-tijd
  if (h < 10) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 21) return "dinner";
  return "snack";
}
