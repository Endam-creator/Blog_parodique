// Génère une page par rubrique (rubriques/<slug>.html) et l'index des rubriques
// (rubriques/index.html) à partir de rubriques.json et articles.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const domain = existsSync('CNAME') ? readFileSync('CNAME', 'utf8').trim() : '';
const SITE = 'https://' + domain.replace(/\/+$/, '');

const rubriques = JSON.parse(readFileSync('rubriques.json', 'utf8'));
const articles = JSON.parse(readFileSync('articles.json', 'utf8'))
    .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));

const known = new Set(rubriques.map(r => r.slug));
for (const a of articles) {
    if (a.rubrique && !known.has(a.rubrique)) console.warn(`⚠️ ${a.id} : rubrique inconnue « ${a.rubrique} » (absente de rubriques.json)`);
}

const OUT = 'rubriques';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const valid = new Set(['index.html', ...rubriques.map(r => r.slug + '.html')]);
for (const f of readdirSync(OUT)) if (f.endsWith('.html') && !valid.has(f)) rmSync(`${OUT}/${f}`);

function picture(img) {
    const rel = '/' + String(img || 'logo_chat_loupe.png').replace(/^\/+/, '');
    const webp = 'images/webp/' + rel.split('/').pop().replace(/\.[^.]+$/, '.webp');
    const tag = `<img src="${esc(rel)}" alt="" loading="lazy" decoding="async">`;
    return existsSync(webp) ? `<picture><source srcset="/${esc(webp)}" type="image/webp">${tag}</picture>` : tag;
}

function card(a) {
    return `<a class="card" href="/articles/${encodeURIComponent(a.id)}.html">${picture(a.img)}` +
        `<div class="card-body"><div class="card-title">${esc(a.title)}</div>` +
        `<div class="card-meta">${esc(a.published || '')}${a.location ? ' · ' + esc(a.location) : ''}</div></div></a>`;
}

function chips(active) {
    return '<div class="chip-row">' +
        `<a class="chip${active === null ? ' active' : ''}" href="/rubriques/">Toutes</a>` +
        rubriques.map(r => `<a class="chip${active === r.slug ? ' active' : ''}" href="/rubriques/${encodeURIComponent(r.slug)}.html">${esc(r.label)}</a>`).join('') +
        '</div>';
}

function page({ title, h1, sub, desc, canonical, body }) {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — Le Blog des Vérités Cachées</title>
<meta name="description" content="${esc('🎭 Parodie : ' + desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)} — Le Blog des Vérités Cachées (parodie)">
<meta property="og:description" content="${esc('🎭 Parodie : ' + desc)}">
<meta property="og:image" content="${SITE}/logo_chat_loupe.png">
<link rel="icon" type="image/png" href="/favicon-96.png">
<link rel="apple-touch-icon" href="/favicon-192.png">
<link rel="stylesheet" href="/assets/page.css">
</head>
<body>
<div class="container" style="max-width:1000px">
    <header>
        <a href="/"><img src="/logo_chat_loupe.png" alt="Logo - chat à la loupe">
        <h1>${h1}<br><span class="slogan">${esc(sub)}</span></h1></a>
    </header>
    <div class="content">
${body}
        <p style="margin-top:22px;font-size:.85rem;color:#555;">🎭 Site parodique : toutes les enquêtes sont inventées. <a href="/mentions-legales.html">Mentions légales</a></p>
    </div>
    <div class="back-bar">
        <a class="back-link" href="/">← Retour aux enquêtes</a>
        <a class="back-link" href="/?hasard" style="margin-left:8px">🎲 Au hasard</a>
    </div>
</div>
</body>
</html>
`;
}

for (const r of rubriques) {
    const list = articles.filter(a => a.rubrique === r.slug);
    writeFileSync(`${OUT}/${r.slug}.html`, page({
        title: r.label.replace(/^\S+\s/, ''),
        h1: esc(r.label),
        sub: `${list.length} enquête${list.length > 1 ? 's' : ''} déclassifiée${list.length > 1 ? 's' : ''}`,
        desc: r.desc,
        canonical: `${SITE}/rubriques/${encodeURIComponent(r.slug)}.html`,
        body: `        ${chips(r.slug)}
        <p>${esc(r.desc)}</p>
        <div class="card-grid">${list.map(card).join('')}</div>
        ${list.length ? '' : '<p>Aucune enquête pour l\'instant. ILS ont dû tout effacer.</p>'}`
    }));
}

writeFileSync(`${OUT}/index.html`, page({
    title: 'Les rubriques',
    h1: 'Les rubriques',
    sub: 'Classées secret défense',
    desc: 'Toutes les enquêtes du Blog des Vérités Cachées, classées par rubrique.',
    canonical: `${SITE}/rubriques/`,
    body: rubriques.map(r => {
        const list = articles.filter(a => a.rubrique === r.slug);
        return `        <h2><a href="/rubriques/${encodeURIComponent(r.slug)}.html" style="color:inherit;text-decoration:none">${esc(r.label)}</a></h2>
        <p>${esc(r.desc)}</p>
        <div class="card-grid">${list.slice(0, 3).map(card).join('')}</div>
        ${list.length > 3 ? `<p><a href="/rubriques/${encodeURIComponent(r.slug)}.html">Voir les ${list.length} enquêtes →</a></p>` : ''}`;
    }).join('\n')
}));

console.log(`${rubriques.length} page(s) de rubrique générée(s) dans ${OUT}/`);
