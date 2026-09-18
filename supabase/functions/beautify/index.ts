// Supabase Edge Function: beautify
// ---------------------------------------------------------------------------
// Takes one raw clothing photo and returns:
//   1. a clean catalog-style image on a solid #f8f8f5 background, and
//   2. a short { name, color, category } tag set, constrained to the app's own
//      COLOR_DICT and category list.
//
// The Gemini API key lives ONLY here (server-side) — never in the browser.
// Set it once:  supabase secrets set GEMINI_API_KEY=xxxxx
// Deploy:       supabase functions deploy beautify
//
// Request  (POST, JSON): { image: "<data URL or base64>", categories: string[], colors: string[] }
// Response (JSON):       { image: "data:image/png;base64,…", meta: {name,color,category}|null, debug? }
// ---------------------------------------------------------------------------

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

// ── Model choice ────────────────────────────────────────────────────────────
// Nano Banana Pro = best quality (matches the gemini.google.com chat result),
// ~$0.13–0.24/image. To cut cost ~3x, switch to "gemini-2.5-flash-image"
// (standard Nano Banana, ~$0.067/image, flatter / less aggressive de-wrinkle).
const IMAGE_MODEL = "gemini-3-pro-image-preview";
const TEXT_MODEL  = "gemini-3.6-flash";         // tagging (cheap); 2.5-flash is retired for new projects
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

// Beautify prompt: the user's proven prompt + explicit ghost-mannequin + de-wrinkle.
const BEAUTIFY_PROMPT = `Act as a professional e-commerce fashion product image editor. I will provide one reference image of a clothing item, footwear, handbag, jewelry, or accessory.
Generate a clean catalog-style product image using these rules:
1. ISOLATE ITEM: Remove the original background, person/model, hanger, props, tags, and unrelated objects. Show only the fashion item.
2. BACKGROUND: Use a uniform solid #f8f8f5 (RGB 248, 248, 245) background that fills the entire canvas. No gradients, no vignette, no visible studio backdrop, no off-white drift. Use only a very subtle soft shadow if needed.
3. 3D FORM (IMPORTANT): Render garments as if worn on an INVISIBLE MANNEQUIN — a ghost-mannequin / hollow-body effect with natural three-dimensional body shape and volume. The piece should stand as if on an unseen body: collar, shoulders, sleeves, and torso filled out and structured. Do NOT present it as a flat lay lying down. (Shoes, bags, and jewelry stay in their natural upright product view.)
4. CAMERA ANGLE (CRITICAL): Show the item in a strict straight-on, dead-center FRONT view, with the camera perpendicular to the garment. Absolutely NO three-quarter angle, NO side view, NO rotated, tilted, diagonal, or perspective view. The garment must be square to the frame and symmetric: shoulders level and equal in width, left and right sides mirroring each other, sleeves falling evenly on both sides. Center and straighten it; do not stretch, widen, shorten, or distort it.
5. MATERIAL & FINISH: Remove ALL wrinkles, creases, and awkward folds for a crisp, freshly-pressed, brand-new look. Remove harsh shadows and glare. Preserve the authentic color, texture, drape, weave, and material — do not over-smooth into a plastic or painted look.
6. DETAILS: Preserve all real details such as zippers, straps, sleeves, hems, buttons, pleats, ties, chains, handles, patterns, embroidery, logos, and hardware. Do not crop or erase delicate parts.
7. STANDARD FRAMING: Keep the entire item visible with consistent padding and scale for its category. Leave 5-8% outer padding for garments, 8-12% for small accessories. Avoid excessive empty space or overly tight cropping.
8. CATEGORY PROPORTIONS: Full-length garments (dresses, pants, long skirts) use most of the image height. Tops and outerwear have balanced width and height. Shorts and short skirts must remain visibly shorter and must not be enlarged to resemble full-length bottoms. Shoes show the complete pair; earrings show the complete matching pair; bags include handles and neatly arranged straps.
The result should look like every item belongs to the same professionally photographed wardrobe catalog, regardless of the original source image.`;

function parseImage(input: string): { data: string; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(input || "");
  if (m) return { mime: m[1], data: m[2] };
  return { mime: "image/jpeg", data: input || "" };
}

// Base64-encode bytes in chunks (avoids arg-count overflow on large buffers).
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

// Fetch an image URL server-side (used by the backfill) and return a data URL.
async function fetchImageAsDataUrl(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not fetch imageUrl (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const mime = r.headers.get("content-type") || "image/jpeg";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

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
      // Pin a consistent portrait shape so every catalog image is the same
      // aspect ratio. imageSize "1K" keeps cost/size down (we downscale to 800 anyway).
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "3:4", imageSize: "1K" },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[beautify] image model error", res.status, body);
    throw new Error(`image model ${res.status}: ${body}`);
  }
  const out = await res.json();
  const img = findImagePart(out);
  if (!img) {
    console.error("[beautify] no image in response", JSON.stringify(out).slice(0, 800));
    throw new Error("image model returned no image");
  }
  return img;
}

async function tag(
  dataB64: string,
  mime: string,
  categories: string[],
  colors: string[],
): Promise<{ name: string; color: string; category: string } | null> {
  const prompt =
    `You are tagging one fashion product photo for a wardrobe catalog. Reply with ONLY a JSON object, no markdown, no extra text, in this exact shape:\n` +
    `{"name": string, "color": string, "category": string}\n\n` +
    `name = a short 2-4 word product name in Title Case (e.g. "Beige Fleece Jacket"). No brand names, no punctuation.\n` +
    `category = choose EXACTLY ONE from this list: ${JSON.stringify(categories)}\n` +
    `color = the single most dominant color, choose EXACTLY ONE from this list: ${JSON.stringify(colors)}. Use "Multicolor" or "Print" only if there is genuinely no single dominant color.`;
  let res: Response;
  try {
    res = await fetch(`${GEMINI}/${TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
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
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
  } catch (err) {
    console.error("[tag] fetch threw", String(err));
    return null;
  }
  if (!res.ok) {
    console.error("[tag] http error", res.status, await res.text());
    return null;
  }
  const out = await res.json();
  const text = out?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("").trim() ?? "";
  if (!text) {
    console.error("[tag] empty text; finishReason:", out?.candidates?.[0]?.finishReason, JSON.stringify(out).slice(0, 500));
    return null;
  }
  try {
    const meta = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); // strip accidental fences
    return {
      name: String(meta.name ?? "").slice(0, 60),
      color: colors.includes(meta.color) ? meta.color : "",
      category: categories.includes(meta.category) ? meta.category : (categories[0] ?? "Other"),
    };
  } catch (err) {
    console.error("[tag] JSON parse failed. raw text:", text.slice(0, 300));
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not set on the function" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const { image, imageUrl, categories, colors } = body ?? {};
  if (!image && !imageUrl) return json({ error: "missing 'image' or 'imageUrl'" }, 400);
  const cats = Array.isArray(categories) && categories.length ? categories : ["Top","Bottom","Shoes","Outerwear","Accessory","Dress","Other"];
  const cols = Array.isArray(colors) && colors.length ? colors : ["Black","White","Gray","Beige","Navy","Blue","Green","Red","Pink","Purple","Brown","Multicolor","Print"];

  let source: string;
  try {
    source = image || await fetchImageAsDataUrl(imageUrl);
  } catch (err) {
    return json({ error: String(err?.message ?? err) }, 400);
  }
  const { data, mime } = parseImage(source);

  try {
    const clean = await beautify(data, mime);          // expensive; failure => 502 => client keeps original
    const meta = await tag(clean.data, clean.mime, cats, cols); // best-effort
    return json({ image: `data:${clean.mime};base64,${clean.data}`, meta, debug: { taggedOk: !!meta } });
  } catch (err) {
    console.error("[serve] failed", String(err?.message ?? err));
    return json({ error: String(err?.message ?? err) }, 502);
  }
});
