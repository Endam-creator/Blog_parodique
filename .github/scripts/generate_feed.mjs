// Génère feed.xml (RSS) et sitemap.xml à partir de articles.json
// Le domaine est lu depuis le fichier CNAME (sinon fallback GitHub Pages).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function escXML(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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

// Tri par date ISO si présente (cohérent avec le site)
if (articles.some(a => a.published)) {
    articles.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
}

function pubDate(art) {
    const d = art.published ? new Date(art.published + 'T08:00:00Z') : new Date();
    return d.toUTCString();
}

// --- feed.xml (RSS 2.0) ---
const items = articles.slice(0, 20).map(art => `    <item>
      <title>${escXML(art.title)}</title>
      <link>${SITE}/articles/${encodeURIComponent(art.id)}.html</link>
      <guid isPermaLink="true">${SITE}/articles/${encodeURIComponent(art.id)}.html</guid>
      <pubDate>${pubDate(art)}</pubDate>
      <description>${escXML(art.desc || art.intro || '')}</description>
    </item>`).join('\n');

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Le Blog des Vérités Cachées</title>
    <link>${SITE}/</link>
    <description>La voix de ceux qui savent. Enquêtes apocryphes et révélations que personne ne vous demandait.</description>
    <language>fr</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;

writeFileSync('feed.xml', rss);
console.log(`feed.xml généré (${articles.length} article(s), domaine: ${SITE})`);

// --- sitemap.xml ---
const today = new Date().toISOString().slice(0, 10);
const urls = [
    `  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod></url>`,
    `  <url><loc>${SITE}/boutique.html</loc></url>`,
    ...articles.map(art =>
        `  <url><loc>${SITE}/articles/${encodeURIComponent(art.id)}.html</loc>` +
        (art.published ? `<lastmod>${escXML(art.published)}</lastmod>` : '') +
        `</url>`)
].join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

writeFileSync('sitemap.xml', sitemap);
console.log('sitemap.xml généré');
