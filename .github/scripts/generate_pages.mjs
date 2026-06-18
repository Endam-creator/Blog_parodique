// Génère une vraie page HTML par article dans articles/<id>.html
// Objectif : SEO Google + aperçus de partage sociaux corrects.
// Chaque page contient le contenu complet (lu par Google et les robots sociaux)
// et redirige le visiteur humain vers le site fluide (index.html?article=<id>).
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

// --- Génération d'une page par article ---
function buildPage(art) {
    const canonical = `${SITE}/articles/${encodeURIComponent(art.id)}.html`;
    const fluidURL = `${SITE}/?article=${encodeURIComponent(art.id)}`;
    const imgPath = resolveImg(art.img);
    const imgAbs = imgPath.startsWith('http') ? imgPath : `${SITE}/${imgPath.replace(/^\/+/, '')}`;
    const desc = art.desc || (art.intro || '').slice(0, 200);

    // Interview en HTML
    let interviewHTML = '';
    if (Array.isArray(art.interview) && art.interview.length) {
        interviewHTML = '<section class="interview"><h2>L\'Interview Exclusive</h2>';
        for (const row of art.interview) {
            interviewHTML += `<p><strong>${escHTML(row.q)}</strong><br>${escHTML(row.a)}</p>`;
        }
        interviewHTML += '</section>';
    }

    const noticeHTML = art.notice
        ? `<aside class="notice">⚠️ L'AVIS DE LA RÉDACTION : ${escHTML(art.notice)}</aside>`
        : '';

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHTML(art.title)} | Le Blog des Vérités Cachées</title>
<meta name="description" content="${escHTML(desc)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="${SITE}/logo_chat_loupe.png">

<!-- Open Graph : aperçu de partage avec le titre et l'image de CETTE enquête -->
<meta property="og:type" content="article">
<meta property="og:site_name" content="Le Blog des Vérités Cachées">
<meta property="og:title" content="${escHTML(art.title)}">
<meta property="og:description" content="${escHTML(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${imgAbs}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHTML(art.title)}">
<meta name="twitter:description" content="${escHTML(desc)}">
<meta name="twitter:image" content="${imgAbs}">

<!-- Données structurées (aide Google à comprendre que c'est un article) -->
<script type="application/ld+json">
${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": art.title,
    "description": desc,
    "image": imgAbs,
    "datePublished": art.published || undefined,
    "author": { "@type": "Person", "name": art.author || "L'Investigateur Anonyme" },
    "publisher": { "@type": "Organization", "name": "Le Blog des Vérités Cachées" },
    "mainEntityOfPage": canonical
}, null, 0)}
</script>

<!-- Redirection des visiteurs humains vers le site fluide (les robots ignorent le JS) -->
<script>
  window.location.replace(${JSON.stringify(fluidURL)});
</script>

<style>
  body { font-family: Arial, sans-serif; max-width: 740px; margin: 0 auto; padding: 25px 18px; color: #1a1a1a; line-height: 1.6; }
  .brand { font-family: 'Impact', sans-serif; text-transform: uppercase; color: #555; font-size: .9rem; letter-spacing: 1px; }
  h1 { font-family: 'Impact', 'Arial Black', sans-serif; text-transform: uppercase; line-height: 1.2; margin: 8px 0 14px; }
  .meta { font-family: monospace; color: #666; font-size: .85rem; border-bottom: 1px dashed #ccc; padding-bottom: 10px; margin-bottom: 16px; }
  img.hero { width: 100%; height: auto; border: 2px solid #111; margin-bottom: 16px; }
  .interview { background: #f7f7f2; border-left: 5px solid #76b900; padding: 14px; margin: 20px 0; }
  .interview h2 { font-family: 'Impact', sans-serif; text-transform: uppercase; font-size: 1.1rem; }
  .notice { background: #fff2a3; border: 2px dashed #a31515; padding: 14px; margin-top: 18px; font-weight: bold; }
  .redirect-note { margin-top: 24px; padding: 14px; background: #111; color: #76b900; text-align: center; }
  .redirect-note a { color: #8ae000; }
</style>
</head>
<body>
  <p class="brand">Le Blog des Vérités Cachées — La voix de ceux qui savent</p>
  <h1>${escHTML(art.title)}</h1>
  <div class="meta">
    Date de publication : ${escHTML(art.date || '')}<br>
    Localisation : ${escHTML(art.location || '')}<br>
    Auteur : ${escHTML(art.author || "L'Investigateur Anonyme")}
  </div>
  <img class="hero" src="${escHTML(imgAbs)}" alt="${escHTML(art.title)}">
  <article>
    <p>${escHTML(art.intro || '')}</p>
    ${interviewHTML}
    ${noticeHTML}
  </article>
  <div class="redirect-note">
    Vous allez être redirigé vers l'enquête complète.
    <br>Si rien ne se passe : <a href="${escHTML(fluidURL)}">cliquez ici pour accéder au Blog des Vérités Cachées</a>.
  </div>
</body>
</html>
`;
}

let count = 0;
for (const art of articles) {
    if (!art.id) continue;
    writeFileSync(`${OUT_DIR}/${art.id}.html`, buildPage(art));
    count++;
}

console.log(`${count} page(s) d'article générée(s) dans ${OUT_DIR}/ (domaine: ${SITE})`);
