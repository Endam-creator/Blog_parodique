// 1) Versions WebP légères de chaque photo (images/webp/<nom>.webp), affichées par le site.
//    Les originaux restent en place et servent de secours si le WebP manque.
// 3) Des « unes » prêtes à poster (carré 1080x1080 et story 1080x1920) dans images/unes/,
//    avec titre, tampon PARODIE et adresse du site.
// 2) Une image d'aperçu de partage (1200x630) par article dans images/og/<id>.jpg,
// avec un tampon « PARODIE · 100 % INVENTÉ » incrusté.
// Objectif : que l'aperçu affiché par X, WhatsApp, Telegram, Facebook… reste
// identifiable comme satire, même capturé ou repartagé sans le texte.
// Les photos originales (images/*.jpg) ne sont pas modifiées : le site les affiche telles quelles.
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import sharp from 'sharp';

const W = 1200, H = 630;
const OUT_DIR = 'images/og';

const articles = JSON.parse(readFileSync('articles.json', 'utf8'));

// --- 1) WebP ---
const WEBP_DIR = 'images/webp';
if (!existsSync(WEBP_DIR)) mkdirSync(WEBP_DIR, { recursive: true });
const sources = readdirSync('images').filter(f => /\.(jpe?g|png)$/i.test(f));
const wanted = new Set(sources.map(f => f.replace(/\.[^.]+$/, '.webp')));
for (const f of readdirSync(WEBP_DIR)) {
    if (!wanted.has(f)) { rmSync(`${WEBP_DIR}/${f}`); console.log('WebP obsolète supprimé : ' + f); }
}
let webpCount = 0;
for (const f of sources) {
    const out = `${WEBP_DIR}/${f.replace(/\.[^.]+$/, '.webp')}`;
    // Ne régénère que si l'original est plus récent (ou si le WebP n'existe pas)
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(`images/${f}`).mtimeMs) continue;
    await sharp(`images/${f}`)
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 72, effort: 6 })
        .toFile(out);
    webpCount++;
}
console.log(`${webpCount} WebP (re)généré(s) dans ${WEBP_DIR}/`);

// --- 2) Aperçus de partage ---
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Nettoyage des aperçus d'articles supprimés
const valid = new Set(articles.map(a => a.id + '.jpg'));
for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.jpg') && !valid.has(f)) {
        rmSync(`${OUT_DIR}/${f}`);
        console.log('Aperçu obsolète supprimé : ' + f);
    }
}

// Tampon : texte rendu puis mesuré, pour que le cadre s'adapte à la police réellement
// disponible sur le serveur (Impact n'existe pas sur les runners Linux).
const LABEL = 'PARODIE · 100 % INVENTÉ';
const RED = '#a31515';

async function buildStamp() {
    const text = await sharp({
        text: { text: `<span foreground="${RED}" letter_spacing="1024">${LABEL}</span>`,
                font: 'DejaVu Sans Bold', dpi: 170, rgba: true }
    }).png().toBuffer();
    const { width: tw, height: th } = await sharp(text).metadata();
    const padX = 30, padY = 16;
    const bw = tw + padX * 2, bh = th + padY * 2;
    const box = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}">
      <rect x="3" y="3" width="${bw - 6}" height="${bh - 6}" fill="#fff" stroke="${RED}" stroke-width="6"/>
      <rect x="11" y="11" width="${bw - 22}" height="${bh - 22}" fill="none" stroke="${RED}" stroke-width="2.5"/>
    </svg>`);
    return sharp(box)
        .composite([{ input: text, top: padY, left: padX }])
        .png().toBuffer()
        .then(b => sharp(b).rotate(-4, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true }));
}

// Voile sombre en bas pour détacher le tampon de la photo
const voile = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/>
  </linearGradient></defs>
  <rect x="0" y="${H - 180}" width="${W}" height="180" fill="url(#v)"/>
</svg>`);

const { data: stamp, info: stampInfo } = await buildStamp();
const stampTop = H - stampInfo.height - 22;

let count = 0;
for (const art of articles) {
    if (!art.id || !art.img) continue;
    const src = art.img.replace(/^\/+/, '');
    if (src.startsWith('http') || !existsSync(src)) {
        console.warn(`⚠️ Image introuvable pour ${art.id} (${art.img}) : aperçu non généré.`);
        continue;
    }
    await sharp(src)
        .resize(W, H, { fit: 'cover', position: 'attention' })
        .composite([
            { input: voile, top: 0, left: 0 },
            { input: stamp, top: stampTop, left: 28 }
        ])
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(`${OUT_DIR}/${art.id}.jpg`);
    count++;
}
console.log(`${count} aperçu(s) de partage généré(s) dans ${OUT_DIR}/`);

// --- 3) Unes pour les réseaux sociaux ---
const UNES_DIR = 'images/unes';
if (!existsSync(UNES_DIR)) mkdirSync(UNES_DIR, { recursive: true });
const unesValid = new Set(articles.flatMap(a => [`${a.id}-carre.jpg`, `${a.id}-story.jpg`]));
for (const f of readdirSync(UNES_DIR)) if (!unesValid.has(f)) rmSync(`${UNES_DIR}/${f}`);

const pango = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const domainUne = existsSync('CNAME') ? readFileSync('CNAME', 'utf8').trim() : '';

async function textImg(markup, opts) {
    return sharp({ text: { text: markup, rgba: true, wrap: 'word', ...opts } }).png().toBuffer({ resolveWithObject: true });
}

async function buildUne(art, W, H, out) {
    const src = art.img.replace(/^\/+/, '');
    const imgH = Math.round(H * 0.56);
    const pad = 60;
    const photo = await sharp(src).resize(W, imgH, { fit: 'cover', position: 'attention' }).toBuffer();
    const titleBoxH = Math.round((H - imgH) * (H > 1500 ? 0.62 : 0.6));
    const title = await textImg(`<span foreground="#ffffff">${pango(art.title.toUpperCase())}</span>`,
        { font: 'DejaVu Sans Bold', width: W - pad * 2, height: titleBoxH, align: 'left' });
    const url = await textImg(`<span foreground="#76b900">▸ ${pango(domainUne)}</span>`,
        { font: 'DejaVu Sans Mono Bold', dpi: H > 1500 ? 190 : 160 });
    const band = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <rect x="0" y="${imgH}" width="${W}" height="${H - imgH}" fill="#111"/>
        <rect x="0" y="${imgH}" width="${W}" height="10" fill="#76b900"/></svg>`);
    const titleTop = imgH + 70;
    await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } })
        .composite([
            { input: photo, top: 0, left: 0 },
            { input: band, top: 0, left: 0 },
            { input: title.data, top: titleTop, left: pad },
            { input: stamp, top: imgH - Math.round(stampInfo.height / 2), left: pad - 10 },
            { input: url.data, top: H - url.info.height - 55, left: pad },
        ])
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(out);
}

let unesCount = 0;
for (const art of articles) {
    if (!art.id || !art.img || !existsSync(art.img.replace(/^\/+/, ''))) continue;
    await buildUne(art, 1080, 1080, `${UNES_DIR}/${art.id}-carre.jpg`);
    await buildUne(art, 1080, 1920, `${UNES_DIR}/${art.id}-story.jpg`);
    unesCount++;
}
console.log(`${unesCount * 2} une(s) générée(s) dans ${UNES_DIR}/`);

