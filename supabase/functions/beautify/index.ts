// Supabase Edge Function: beautify
// ---------------------------------------------------------------------------
// Takes one raw clothing photo and returns:
//   1. a clean catalog-style image on a solid #f8f8f5 background (Gemini 2.5
//      Flash Image, "Nano Banana"), and
//   2. a short { name, color, category } tag set (Gemini 2.5 Flash), constrained
//      to the app's own COLOR_DICT and category list.
//
// The Gemini API key lives ONLY here (server-side) — never in the browser.
// Set it once with:  supabase secrets set GEMINI_API_KEY=xxxxx
// Deploy with:       supabase functions deploy beautify
//
// Request  (POST, JSON): { image: "<data URL or base64>", categories: string[], colors: string[] }
// Response (JSON):       { image: "data:image/png;base64,…", meta: { name, color, category } | null }
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const IMAGE_MODEL = "gemini-2.5-flash-image";   // beautify (image out)
const TEXT_MODEL  = "gemini-2.5-flash";         // tagging (JSON out)
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// The user's proven beautify prompt, plus a hard background rule.
const BEAUTIFY_PROMPT = `Act as a professional e-commerce fashion product image editor. I will provide one reference image of a clothing item, footwear, handbag, jewelry, or accessory.
Generate a clean catalog-style product image using these rules:
1. ISOLATE ITEM: Remove the original background, person/model, hanger, props, tags, and unrelated objects. Show only the fashion item.
2. BACKGROUND: Use a uniform solid #f8f8f5 (RGB 248, 248, 245) background that fills the entire canvas. No gradients, no vignette, no visible studio backdrop, no off-white drift. Use only a very subtle soft shadow if needed.
3. ALIGNMENT: Straighten and center the item. Present it front-facing, level, balanced, and naturally proportioned. Do not stretch, widen, shorten, or distort it.
4. DETAILS: Preserve all real details such as straps, sleeves, hems, buttons, pleats, ties, chains, handles, patterns, embroidery, and hardware. Do not crop or erase delicate parts.
5. MATERIAL: Preserve the authentic color, texture, drape, shine, and material. Remove distracting wrinkles, harsh shadows, glare, and awkward folds without over-smoothing.
6. STANDARD FRAMING: Keep the entire item visible with consistent padding and scale for its category. Normally leave 5-8% outer padding for garments and 8-12% for small accessories. Avoid excessive empty space or overly tight cropping.
7. CATEGORY PROPORTIONS: Full-length garments such as dresses, pants, and long skirts should use most of the image height. Tops and outerwear should have balanced width and height. Shorts and short skirts must remain visibly shorter and must not be enlarged to resemble full-length bottoms. Shoes should show the complete pair; earrings should show the complete matching pair; bags should include handles and neatly arranged straps.
The result should look like every item belongs to the same professionally photographed wardrobe catalog, regardless of the original source image.`;

// Pull raw base64 + mime out of a data URL or a bare base64 string.
function parseImage(input: string): { data: string; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(input || "");
  if (m) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: input || "" };
}

// Find the first inline image part in a Gemini response (handles camel/snake).
function findImagePart(resp: any): { data: string; mime: string } | null {
  const parts = resp?.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) return { data: inline.data, mime: inline.mimeType ?? inline.mime_type ?? "image/png" };
  }
  return null;
}

async function beautify(dataB64: string, mime: string): Promise<{ data: string; mime: string }> {
  const res = await fetch(`${GEMINI}/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: BEAUTIFY_PROMPT },
          { inline_data: { mime_type: mime, data: dataB64 } },
        ],
      }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  if (!res.ok) throw new Error(`image model ${res.status}: ${await res.text()}`);
  const out = await res.json();
  const img = findImagePart(out);
  if (!img) throw new Error("image model returned no image");
  return img;
}

async function tag(
  dataB64: string,
  mime: string,
  categories: string[],
  colors: string[],
): Promise<{ name: string; color: string; category: string } | null> {
  const prompt =
    `You are tagging a single fashion product photo for a wardrobe catalog. Return only the fields requested.\n` +
    `- name: a short 2-4 word product name in Title Case (e.g. "Pink Ribbed Blouse"). No brand names, no punctuation.\n` +
    `- color: the single most dominant color. Choose exactly one from the allowed list. Use "Multicolor" or "Print" only if there is genuinely no single dominant color.\n` +
    `- category: choose exactly one from the allowed list that best fits the item.`;
  const res = await fetch(`${GEMINI}/${TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mime, data: dataB64 } },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            color: { type: "STRING", enum: colors },
            category: { type: "STRING", enum: categories },
          },
          required: ["name", "color", "category"],
          propertyOrdering: ["name", "color", "category"],
        },
        temperature: 0.2,
      },
    }),
  });
  if (!res.ok) return null; // tagging is best-effort; never block the image
  const out = await res.json();
  const text = out?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  try {
    const meta = JSON.parse(text);
    return {
      name: String(meta.name ?? "").slice(0, 60),
      color: colors.includes(meta.color) ? meta.color : "",
      category: categories.includes(meta.category) ? meta.category : (categories[0] ?? "Other"),
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not set on the function" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const { image, categories, colors } = body ?? {};
  if (!image) return json({ error: "missing 'image'" }, 400);
  const cats = Array.isArray(categories) && categories.length ? categories : ["Top","Bottom","Shoes","Outerwear","Accessory","Dress","Other"];
  const cols = Array.isArray(colors) && colors.length ? colors : ["Black","White","Gray","Beige","Navy","Blue","Green","Red","Pink","Purple","Brown","Multicolor","Print"];

  const { data, mime } = parseImage(image);

  try {
    // 1) Beautify (the expensive call). If this fails, the whole request fails
    //    and the client falls back to the original photo.
    const clean = await beautify(data, mime);
    // 2) Tag the CLEANED image (best colour read on a neutral background).
    const meta = await tag(clean.data, clean.mime, cats, cols);
    return json({ image: `data:${clean.mime};base64,${clean.data}`, meta });
  } catch (err) {
    return json({ error: String(err?.message ?? err) }, 502);
  }
});
