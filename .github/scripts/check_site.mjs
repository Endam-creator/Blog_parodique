// Contrôle du site généré AVANT sa mise en ligne.
// En cas de problème, le script échoue : la GitHub Action s'arrête avant le commit,
// le site reste dans son état précédent et GitHub envoie un e-mail d'alerte.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const errors = [];
const warn = [];
const articles = JSON.parse(readFileSync('articles.json', 'utf8'));
const rubriques = existsSync('rubriques.json') ? JSON.parse(readFileSync('rubriques.json', 'utf8')) : [];
const rubSlugs = new Set(rubriques.map(r => r.slug));

// 1) Chaque enquête publiée : image, pages et visuels générés
for (const a of articles) {
    const who = `« ${String(a.title || a.id).slice(0, 60)} »`;
    const img = String(a.img || '').replace(/^\/+/, '');
    if (!img) warn.push(`${who} : pas d'image (le logo sera utilisé)`);
    else if (!/^https?:/.test(img) && !existsSync(img)) errors.push(`${who} : image introuvable « ${a.img} » (dépose-la dans images/)`);
    if (a.rubrique && !rubSlugs.has(a.rubrique)) errors.push(`${who} : rubrique inconnue « ${a.rubrique} » (à déclarer dans rubriques.json)`);
    if (!a.rubrique) warn.push(`${who} : aucune rubrique`);
    if (!a.published || !/^\d{4}-\d{2}-\d{2}/.test(a.published)) errors.push(`${who} : date de publication absente ou invalide`);

    const page = `articles/${a.id}.html`;
    if (!existsSync(page)) { errors.push(`${who} : page ${page} non générée`); continue; }
    const html = readFileSync(page, 'utf8');
    if (statSync(page).size < 5000) errors.push(`${who} : page ${page} anormalement petite`);
    if (!html.includes('Article parodique')) errors.push(`${who} : mention parodie absente de ${page}`);
    if (img && !/^https?:/.test(img) && existsSync(img)) {
        if (!existsSync(`images/og/${a.id}.jpg`)) errors.push(`${who} : aperçu de partage images/og/${a.id}.jpg manquant`);
        for (const f of ['carre', 'story']) if (!existsSync(`images/unes/${a.id}-${f}.jpg`)) errors.push(`${who} : une ${f} manquante`);
    }
}

// 2) Liens et ressources internes de toutes les pages HTML
function htmlFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        if (e.name.startsWith('.') || e.name === 'node_modules') return [];
        const p = dir === '.' ? e.name : `${dir}/${e.name}`;
        return e.isDirectory() ? htmlFiles(p) : (p.endsWith('.html') ? [p] : []);
    });
}
function resolves(url) {
    let path = decodeURIComponent(url.split(/[?#]/)[0]).replace(/^\/+/, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';
    return existsSync(path) && (statSync(path).isFile() || existsSync(path + '/index.html'));
}
let checked = 0;
for (const file of htmlFiles('.')) {
    const html = readFileSync(file, 'utf8');
    // Seuls les chemins absolus internes (« /… ») sont vérifiés ; le code JS n'est pas analysé
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    for (const m of markup.matchAll(/\b(?:href|src|srcset)="(\/[^"\s]*)"/g)) {
        const url = m[1];
        if (url.startsWith('//')) continue;
        checked++;
        if (!resolves(url)) errors.push(`${file} : lien cassé « ${url} »`);
    }
}

// 3) Fichiers indispensables
for (const f of ['index.html', 'assets/site.js', 'assets/site.css', 'feed.xml', 'sitemap.xml', 'rubriques/index.html']) {
    if (!existsSync(f)) errors.push(`fichier indispensable manquant : ${f}`);
}

for (const w of [...new Set(warn)]) console.log('⚠️  ' + w);
if (errors.length) {
    console.error(`\n❌ ${errors.length} problème(s) détecté(s) — mise en ligne bloquée :`);
    for (const e of [...new Set(errors)]) console.error('   • ' + e);
    process.exit(1);
}
console.log(`✅ Contrôle OK : ${articles.length} enquête(s), ${checked} lien(s) interne(s) vérifié(s)`);
