// Génère automatiquement l'image d'une enquête avec Gemini (Google AI Studio).
//
// Une enquête est traitée si son champ « img_prompt » est rempli ET
//   - qu'elle n'a pas encore d'image, ou
//   - que la case « img_regen » (Régénérer l'image) est cochée.
// L'image est enregistrée dans images/<id>-ia-<horodatage>.jpg, le champ « img » est mis à jour
// et « img_regen » est décochée. Les étapes suivantes de l'Action produisent ensuite
// WebP, aperçu de partage tamponné et unes.
//
// Secret GitHub requis : GEMINI_API_KEY (clé créée sur https://aistudio.google.com)
// Variable facultative : GEMINI_IMAGE_MODEL (par défaut gemini-3.1-flash-image)
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import sharp from 'sharp';

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const MAX_PER_RUN = 3;   // garde-fou sur le coût
const DIR = 'content/enquetes';
const API = 'https://generativelanguage.googleapis.com/v1beta';

// Style commun à toutes les illustrations du blog (ajouté à chaque description)
const STYLE = [
    'Photorealistic documentary photograph, French tabloid / regional newspaper reportage style,',
    'natural available light, slightly gritty everyday setting, candid, 35mm lens, 16:9 landscape framing.',
    'The scene must read as comic and absurd on close inspection.',
    'No text overlays, no captions, no logos, no watermarks.',
    'Do not depict any real, identifiable person or celebrity; all people are fictional and ordinary-looking.',
].join(' ');

const todo = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const path = `${DIR}/${f}`;
    return { path, art: JSON.parse(readFileSync(path, 'utf8')) };
}).filter(({ art }) => String(art.img_prompt || '').trim() && (!art.img || art.img_regen === true));

if (!todo.length) { console.log('Aucune image IA à générer.'); process.exit(0); }
if (!KEY) {
    console.log(`::warning::${todo.length} enquête(s) attendent une image IA, mais le secret GEMINI_API_KEY n'est pas configuré.`);
    process.exit(0);
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
        const raw = await generate(art.img_prompt);
        const file = `images/${art.id}-ia-${Date.now()}.jpg`;
        await sharp(raw).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toFile(file);
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
