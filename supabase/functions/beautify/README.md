# Beautify Edge Function — deploy guide (Phase 1)

Turns a raw clothing photo into a clean `#f8f8f5` catalog image **and** auto-tags it with
`{ name, color, category }`, all in one call. The Gemini API key stays server-side.

## What's in this folder
- `index.ts` — the function (Gemini 2.5 Flash Image for beautify + Gemini 2.5 Flash for tags).

## 1. Get a Gemini API key (paid tier)
Image generation has **no free tier**, so the key must be on pay-as-you-go billing.
1. Go to Google AI Studio → **Get API key** → create a key in a Google Cloud project.
2. Enable billing on that project (Gemini image gen won't run on a free-only key).
   Cost is ~**$0.067 per photo** beautified; tagging adds well under a tenth of a cent.

## 2. Set the key as a function secret (never in the app)
```bash
cd <repo root>            # the folder containing supabase/
supabase secrets set GEMINI_API_KEY=YOUR_KEY_HERE
```

## 3. Deploy
```bash
supabase functions deploy beautify
```
Your project is already linked (`supabase/.temp/linked-project.json`), so this just works.

## 4. Turn it on in the app
`index.html` already has, near the top of the script block:
```js
const AI_BEAUTIFY  = true;                                  // set false to disable
const BEAUTIFY_URL = `${SUPABASE_URL}/functions/v1/beautify`;
```
Nothing else to configure — `BEAUTIFY_URL` is derived from your existing `SUPABASE_URL`, and
the app sends your logged-in user's token so the function is not open to the public.

## 5. Try it
Open the app → **Wardrobe → + Add items** (or the single Add form) → drop a raw photo.
You'll see "Beautifying…" then "Uploading…", and the item lands cleaned, on `#f8f8f5`, with
name / color / category pre-filled. Edit anything before/after saving.

## How it behaves
- **Fail-safe:** if the function errors or is unreachable, the upload still completes with the
  **original** photo and a small "AI skipped — used original photo" note. You never lose an add.
- **Tags are constrained** to the app's own `COLOR_DICT` and your category list, so they drop
  straight into the dropdowns. Tagging runs on the *cleaned* image for a better color read.
- **Auto-tag is best-effort:** if only the tagging half fails, you still get the clean image.

## Auth note
Functions deploy with `verify_jwt` on by default; the app passes the user's Supabase access
token, so real requests pass. To test with `curl`, either pass a valid user token in the
`Authorization` header, or deploy once with `--no-verify-jwt` **for testing only**:
```bash
supabase functions deploy beautify --no-verify-jwt   # testing only; redeploy without it after
curl -i -X POST "$SUPABASE_URL/functions/v1/beautify" \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON" \
  -d '{"image":"data:image/jpeg;base64,....","categories":["Top","Bottom"],"colors":["Black","White"]}'
```

## Troubleshooting
- **500 "GEMINI_API_KEY not set"** → run step 2, then redeploy.
- **502 image model 4xx** → billing not enabled on the key, or the model name changed. The
  model is `IMAGE_MODEL = "gemini-2.5-flash-image"` in `index.ts`; update it if Google renames it.
- **502 "returned no image"** → some API versions want both modalities. In `index.ts` change
  `responseModalities: ["IMAGE"]` to `["TEXT","IMAGE"]` and redeploy.
- **401 / CORS** → make sure the app sends the `Authorization` + `apikey` headers (it does by
  default via `beautifyImage()`), and that you deployed the latest `index.ts` (CORS is built in).

## Cost recap
~$0.067 per photo (beautify) + ~$0.0004 (tags). A 200-item backfill ≈ $13–14; ~20 new
items/month ≈ $1.35/month. Cloudinary and Supabase stay on their free tiers at this scale.
