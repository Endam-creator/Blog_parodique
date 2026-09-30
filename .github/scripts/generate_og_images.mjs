// Génère une image d'aperçu de partage (1200x630) par article dans images/og/<id>.jpg,
// avec un tampon « PARODIE · 100 % INVENTÉ » incrusté.
// Objectif : que l'aperçu affiché par X, WhatsApp, Telegram, Facebook… reste
// identifiable comme satire, même capturé ou repartagé sans le texte.
// Les photos originales (images/*.jpg) ne sont pas modifiées : le site les affiche telles quelles.
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import sharp from 'sharp';

const W = 1200, H = 630;
const OUT_DIR = 'images/og';

const articles = JSON.parse(readFileSync('articles.json', 'utf8'));
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
