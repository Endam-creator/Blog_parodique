// Génère automatiquement l'image d'une enquête par IA.
//
// Fournisseur utilisé :
//   1. Cloudflare Workers AI (FLUX.1 schnell) — GRATUIT : quota quotidien de l'offre gratuite,
//      jamais de facturation (au-delà, la génération échoue simplement jusqu'au lendemain).
//      Secrets : CLOUDFLARE_API_TOKEN (avec la permission « Workers AI ») et CLOUDFLARE_ACCOUNT_ID.
//   2. Gemini (payant) — seulement si le secret GEMINI_API_KEY est configuré.
//
// Une enquête est traitée si son champ « img_prompt » est rempli ET
//   - qu'elle n'a pas encore d'image, ou
//   - que la case « img_regen » (Régénérer l'image) est cochée.
// L'image est enregistrée dans images/<id>-ia-<horodatage>.jpg, le champ « img » est mis à jour
// et « img_regen » est décochée. Les étapes suivantes de l'Action produisent ensuite
// WebP, aperçu de partage tamponné et unes.
//
// Variable facultative : GEMINI_IMAGE_MODEL (par défaut gemini-3.1-flash-image)
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import sharp from 'sharp';

const KEY = process.env.GEMINI_API_KEY;
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const PROVIDER = KEY ? 'gemini' : (CF_TOKEN && CF_ACCOUNT ? 'cloudflare' : null);
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const MAX_PER_RUN = 3;   // garde-fou sur le coût
const DIR = 'content/enquetes';
const API = 'https://generativelanguage.googleapis.com/v1beta';

// Style commun à toutes les illustrations du blog (ajouté à chaque description)
const STYLE = [
    'Photorealistic documentary photograph, French tabloid / regional newspaper reportage style,',
    'natural available light, slightly gritty everyday setting, candid, 35mm lens, 16:9 landscape framing.',
    'The scene must read as comic and absurd on close inspection.',
    'Absolutely no written text anywhere: no letters, words, signs, labels, captions, book titles, posters with words or screens showing text; no logos, no watermarks.',
    'Wide landscape composition: keep the main character (including the whole head) and the key props inside the central horizontal band of the frame, with plain background above and below.',
    'Do not depict any real, identifiable person or celebrity; all people are fictional and ordinary-looking.',
].join(' ');

const todo = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const path = `${DIR}/${f}`;
    const art = JSON.parse(readFileSync(path, 'utf8'));
    if (!art.id) art.id = f.replace(/\.json$/, '');   // nouvelle enquête : id = nom du fichier
    return { path, art };
}).filter(({ art }) => String(art.img_prompt || '').trim() && (!art.img || art.img_regen === true));

if (!todo.length) { console.log('Aucune image IA à générer.'); process.exit(0); }
if (!PROVIDER) {
    console.log(`::warning::${todo.length} enquête(s) attendent une image IA, mais aucun fournisseur n'est configuré (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, ou GEMINI_API_KEY).`);
    process.exit(0);
}
console.log(`Fournisseur d'images : ${PROVIDER === 'cloudflare' ? 'Cloudflare Workers AI (FLUX.1 schnell, gratuit)' : 'Gemini (' + MODEL + ')'}`);

// Cloudflare Workers AI — FLUX.1 schnell (image carrée, recadrée ensuite en 16:9)
async function generateCloudflare(prompt) {
    const full = `${prompt.trim()} ${STYLE}`.slice(0, 2000);
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CF_TOKEN}` },
        body: JSON.stringify({ prompt: full, steps: 8 }),
        signal: AbortSignal.timeout(180000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    const img = json?.result?.image;
    if (!r.ok || !img) {
        const hint = r.status === 403 || r.status === 401
            ? ' (le jeton Cloudflare doit avoir la permission « Workers AI »)'
            : (r.status === 429 ? ' (quota gratuit du jour atteint, réessai au prochain passage)' : '');
        throw new Error(`Cloudflare Workers AI → ${r.status}${hint} ${text.slice(0, 300)}`);
    }
    return Buffer.from(img, 'base64');
}

// Cherche récursivement une image base64 dans la réponse (compatible avec les deux formats d'API)
function findImage(node) {
    if (!node || typeof node !== 'object') return null;
    const mime = node.mimeType || node.mime_type;
    if (typeof node.data === 'string' && node.data.length > 1000 && (!mime || String(mime).startsWith('image/'))) return node.data;
    for (const v of Object.values(node)) {
        const found = findImage(v);
        if (found) return found;
    }
    return null;
}

async function call(url, body) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, json, text };
}

async function generate(prompt) {
    const full = `${prompt.trim()}\n\n${STYLE}`;
    // 1) API « interactions » (format actuel de la documentation Google)
    let r = await call(`${API}/interactions`, {
        model: MODEL,
        input: [{ type: 'text', text: full }],
        response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '2K' },
    });
    let data = r.ok ? findImage(r.json) : null;
    // 2) Repli : API generateContent
    if (!data) {
        const first = `${r.status} ${String(r.text).slice(0, 300)}`;
        r = await call(`${API}/models/${encodeURIComponent(MODEL)}:generateContent`, {
            contents: [{ role: 'user', parts: [{ text: full }] }],
            generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
        });
        data = r.ok ? findImage(r.json) : null;
        if (!data) throw new Error(`Gemini n'a pas renvoyé d'image.\n  interactions → ${first}\n  generateContent → ${r.status} ${String(r.text).slice(0, 300)}`);
    }
    return Buffer.from(data, 'base64');
}

let done = 0, failed = 0;
for (const { path, art } of todo.slice(0, MAX_PER_RUN)) {
    const label = `« ${String(art.title || art.id).slice(0, 60)} »`;
    try {
        console.log(`🎨 Génération de l'image pour ${label}…`);
        const raw = PROVIDER === 'cloudflare' ? await generateCloudflare(art.img_prompt) : await generate(art.img_prompt);
        const file = `images/${art.id}-ia-${Date.now()}.jpg`;
        // Format paysage 16:9 comme les autres illustrations. Les images carrées sont recadrées
        // un peu au-dessus du centre (35 % de la marge en haut) pour ne pas couper les visages.
        const meta = await sharp(raw).metadata();
        const scaled = await sharp(raw).resize({ width: 1600 }).toBuffer();
        const h = Math.round(1600 * meta.height / meta.width);
        const img = h > 900
            ? sharp(scaled).extract({ left: 0, top: Math.round((h - 900) * 0.35), width: 1600, height: 900 })
            : sharp(scaled).resize(1600, 900, { fit: 'cover' });
        await img.jpeg({ quality: 86, mozjpeg: true }).toFile(file);
        // Supprime l'ancienne image IA de cette enquête (pas les images déposées à la main)
        const old = String(art.img || '').replace(/^\/+/, '');
        if (old && old !== file && /-ia-\d+\.jpg$/.test(old) && existsSync(old)) rmSync(old);
        art.img = file;
        art.img_regen = false;
        writeFileSync(path, JSON.stringify(art, null, 2) + '\n');
        console.log(`   ✅ ${file}`);
        done++;
    } catch (e) {
        console.log(`::warning::Image IA non générée pour ${label} : ${e.message}`);
        failed++;
    }
}
if (todo.length > MAX_PER_RUN) console.log(`⏭️  ${todo.length - MAX_PER_RUN} image(s) restante(s) : elles seront générées au prochain passage.`);
console.log(`${done} image(s) IA générée(s), ${failed} échec(s).`);
