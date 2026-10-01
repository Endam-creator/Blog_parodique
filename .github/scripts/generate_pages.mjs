// Génère une vraie page HTML par article dans articles/<id>.html.
// La page est construite à partir d'index.html (même design, mêmes fonctions : votes,
// commentaires, fil…) avec :
//   - un <head> propre à l'article (titre, description, canonical, Open Graph, Schema.org)
//   - le contenu de l'article déjà présent dans le HTML (lu par Google sans JavaScript)
//   - window.__ARTICLE_ID__ pour que le site affiche directement cette enquête.
// Aucune redirection : l'URL /articles/<id>.html EST la page de l'article.
//
// Le domaine est lu depuis le fichier CNAME (sinon fallback GitHub Pages).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

function escHTML(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- Domaine du site ---
let domain = '';
if (existsSync('CNAME')) {
    domain = readFileSync('CNAME', 'utf8').trim();
} else if (process.env.GITHUB_REPOSITORY) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    domain = `${owner}.github.io/${repo}`;
}
const SITE = 'https://' + domain.replace(/\/+$/, '');

// --- Lecture des articles ---
const articles = JSON.parse(readFileSync('articles.json', 'utf8'));
if (!Array.isArray(articles)) {
    console.error('ERREUR : articles.json doit contenir un tableau JSON.');
    process.exit(1);
}

// --- Résolution du chemin d'image (même logique que le site) ---
function resolveImg(raw) {
    if (!raw) return 'logo_chat_loupe.png';
    return raw; // le chemin du JSON est utilisé tel quel pour l'URL absolue
}

// --- Dossier de sortie ---
const OUT_DIR = 'articles';
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Nettoyage : on supprime les anciennes pages .html qui ne correspondent plus
// à un article existant (articles supprimés).
const validFiles = new Set(articles.map(a => a.id + '.html'));
if (existsSync(OUT_DIR)) {
    for (const f of readdirSync(OUT_DIR)) {
        if (f.endsWith('.html') && !validFiles.has(f)) {
            rmSync(`${OUT_DIR}/${f}`);
            console.log('Page obsolète supprimée : ' + f);
        }
    }
}

// Date affichée : champ « date » si rempli, sinon calculée depuis « published » (AAAA-MM-JJ)
function displayDate(art) {
    if (art.date) return art.date;
    if (!art.published) return '';
    const d = new Date(art.published + 'T12:00:00Z');
    if (isNaN(d)) return art.published;
    const str = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// --- Gabarit : index.html ---
const TEMPLATE = readFileSync('index.html', 'utf8');
const SEO_RE = /<!-- SEO:START[\s\S]*?<!-- SEO:END -->/;
const VIEWER_MARK = '<!-- PRERENDER -->';
if (!SEO_RE.test(TEMPLATE) || !TEMPLATE.includes(VIEWER_MARK)) {
    console.error('ERREUR : marqueurs SEO:START/SEO:END ou PRERENDER introuvables dans index.html.');
    process.exit(1);
}

const PARODY_NOTE = "<strong>🎭 Article parodique</strong> — Faits, témoins et citations sont entièrement inventés. Certifié 100 % faux par la Rédaction.";

// <picture> : WebP allégé si disponible, image d'origine sinon
function pictureTag(imgRel, alt) {
    const webp = '/images/webp/' + imgRel.split('/').pop().replace(/\.[^.]+$/, '.webp');
    const img = `<img src="${escHTML(imgRel)}" alt="${escHTML(alt)}" fetchpriority="high" decoding="async">`;
    return existsSync(webp.slice(1)) && /\.(jpe?g|png)$/i.test(imgRel)
        ? `<picture><source srcset="${escHTML(webp)}" type="image/webp">${img}</picture>` : img;
}

// --- Génération d'une page par article ---
function buildPage(art, isLatest) {
    const canonical = `${SITE}/articles/${encodeURIComponent(art.id)}.html`;
    const imgPath = resolveImg(art.img);
    const imgAbs = imgPath.startsWith('http') ? imgPath : `${SITE}/${imgPath.replace(/^\/+/, '')}`;
    const imgRel = imgPath.startsWith('http') ? imgPath : '/' + imgPath.replace(/^\/+/, '');
    // Aperçu de partage tamponné « PARODIE » (généré par generate_og_images.mjs), sinon image d'origine
    const ogPath = `images/og/${art.id}.jpg`;
    const ogAbs = existsSync(ogPath) ? `${SITE}/${ogPath}` : imgAbs;
    const desc = art.desc || (art.intro || '').slice(0, 200);
    // Mention parodie dans tout ce qui circule hors du site (aperçus X, WhatsApp, Google...)
    const shareDesc = '🎭 Parodie : ' + desc;
    const shareTitle = art.title + ' (parodie)';

    const ld = {
        "@context": "https://schema.org",
        "@type": "SatiricalArticle",
        "headline": art.title,
        "description": desc,
        "image": ogAbs,
        "datePublished": art.published || undefined,
        "author": { "@type": "Person", "name": art.author || "L'Investigateur Anonyme" },
        "publisher": { "@type": "Organization", "name": "Le Blog des Vérités Cachées" },
        "mainEntityOfPage": canonical
    };

    const head = `<title>${escHTML(art.title)} | Le Blog des Vérités Cachées</title>
    <meta name="description" content="${escHTML(shareDesc)}">
    <link rel="canonical" href="${canonical}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Le Blog des Vérités Cachées">
    <meta property="og:title" content="${escHTML(shareTitle)}">
    <meta property="og:description" content="${escHTML(shareDesc)}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${ogAbs}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escHTML(shareTitle)}">
    <meta name="twitter:description" content="${escHTML(shareDesc)}">
    <meta name="twitter:image" content="${ogAbs}">
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
    <script>window.__ARTICLE_ID__ = ${JSON.stringify(art.id).replace(/</g, '\\u003c')};</script>`;

    // Contenu pré-rendu (même structure que displayArticle() dans index.html)
    let interviewHTML = '';
    if (Array.isArray(art.interview) && art.interview.length) {
        interviewHTML = '<div class="interview-box"><h3>L\'Interview Exclusive</h3>' +
            art.interview.map(r => `<div class="interview-line"><strong>${escHTML(r.q)}</strong>${escHTML(r.a)}</div>`).join('') +
            '</div>';
    }
    const noticeHTML = art.notice ? `<div class="redac-notice">⚠️ L'AVIS DE LA RÉDACTION : ${escHTML(art.notice)}</div>` : '';
    const stamp = art.classified ? '<span class="classified-stamp big">Classified</span>' : '';
    const banner = isLatest ? '<div class="breaking-banner">Breaking News</div>' : '<div class="archive-banner">Archive déclassifiée</div>';

    const body =
        `<div class="meta-data">LE BLOG DES VÉRITÉS CACHÉES – La voix de ceux qui savent<br>` +
        `Date de publication : ${escHTML(displayDate(art))}<br>` +
        `Localisation : ${escHTML(art.location || '')}<br>` +
        `Auteur : ${escHTML(art.author || "L'Investigateur Anonyme")}</div>` +
        banner +
        `<div class="hero-visual">${pictureTag(imgRel, art.title)}` +
        `<div class="hero-title-overlay"><h2>${escHTML(art.title)}</h2></div>${stamp}</div>` +
        `<div class="parody-banner" role="note">${PARODY_NOTE}</div>` +
        `<div class="article-body"><p>${escHTML(art.intro || '')}</p>${interviewHTML}${noticeHTML}</div>`;

    return TEMPLATE
        .replace(SEO_RE, () => head)
        .replace(VIEWER_MARK, () => body);
}

let count = 0;
// Même tri que le site : l'article le plus récent porte le bandeau « Breaking News »
const sorted = articles.some(a => a.published)
    ? [...articles].sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')))
    : articles;
const latestId = sorted.length ? sorted[0].id : null;

for (const art of articles) {
    if (!art.id) continue;
    writeFileSync(`${OUT_DIR}/${art.id}.html`, buildPage(art, art.id === latestId));
    count++;
}

console.log(`${count} page(s) d'article générée(s) dans ${OUT_DIR}/ (domaine: ${SITE})`);
