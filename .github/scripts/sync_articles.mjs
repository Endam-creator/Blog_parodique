// Synchronise les deux formats des enquêtes :
//   content/enquetes/<id>.json  ← source éditée par Pages CMS (un fichier par enquête)
//   articles.json               ← fichier unique lu par le site (généré)
//
// Par défaut : reconstruit articles.json à partir de content/enquetes/.
// Mode « --import » : découpe articles.json en fichiers (utilisé quand articles.json
// a été modifié à la main, ex. ancienne console, sans toucher à content/).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const DIR = 'content/enquetes';
const ORDER = ['id', 'published', 'title', 'date', 'location', 'author', 'img', 'desc', 'intro', 'interview', 'notice', 'classified'];

function clean(art) {
    const out = {};
    for (const k of [...ORDER, ...Object.keys(art).filter(k => !ORDER.includes(k))]) {
        let v = art[k];
        if (v === undefined || v === null) continue;
        if (k === 'img' && typeof v === 'string') v = v.replace(/^\/+/, '');   // Pages CMS écrit /images/x.jpg
        if (k === 'interview') v = (Array.isArray(v) ? v : []).filter(r => r && (r.q || r.a));
        out[k] = v;
    }
    return out;
}
const byDate = (a, b) => String(b.published || '').localeCompare(String(a.published || ''));

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

if (process.argv.includes('--import')) {
    const articles = JSON.parse(readFileSync('articles.json', 'utf8'));
    const keep = new Set();
    for (const art of articles) {
        if (!art.id) continue;
        writeFileSync(`${DIR}/${art.id}.json`, JSON.stringify(clean(art), null, 2) + '\n');
        keep.add(art.id + '.json');
    }
    for (const f of readdirSync(DIR)) if (f.endsWith('.json') && !keep.has(f)) rmSync(`${DIR}/${f}`);
    console.log(`📥 ${keep.size} enquête(s) importée(s) depuis articles.json vers ${DIR}/`);
} else {
    const articles = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
        const art = clean(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')));
        if (!art.id) art.id = f.replace(/\.json$/, '');
        return art;
    }).sort(byDate);
    writeFileSync('articles.json', JSON.stringify(articles, null, 2) + '\n');
    console.log(`📰 articles.json reconstruit : ${articles.length} enquête(s)`);
}
