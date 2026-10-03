// Synchronise les deux formats des enquêtes :
//   content/enquetes/<id>.json  ← source éditée par Pages CMS (un fichier par enquête)
//   articles.json               ← fichier unique lu par le site (généré)
//
// Par défaut : reconstruit articles.json à partir de content/enquetes/.
// Brouillons et publication programmée : une enquête n'entre dans articles.json
// (donc sur le site, le RSS, le sitemap…) que si elle n'est pas en brouillon
// et que sa date de publication est aujourd'hui ou passée (heure de Paris).
// Une GitHub Action quotidienne publie les enquêtes programmées le jour venu.
//
// Mode « --import » : découpe articles.json en fichiers (utilisé quand articles.json
// a été modifié à la main, ex. ancienne console, sans toucher à content/).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const DIR = 'content/enquetes';
const ORDER = ['id', 'published', 'brouillon', 'rubrique', 'title', 'date', 'location', 'author', 'img', 'desc', 'intro', 'interview', 'notice', 'classified'];

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

// Date du jour à Paris, au format AAAA-MM-JJ
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const isDraft = a => a.brouillon === true;
const isScheduled = a => !!a.published && String(a.published).slice(0, 10) > TODAY;
const isPublic = a => !isDraft(a) && !isScheduled(a);

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

if (process.argv.includes('--import')) {
    const articles = JSON.parse(readFileSync('articles.json', 'utf8'));
    const keep = new Set();
    for (const art of articles) {
        if (!art.id) continue;
        writeFileSync(`${DIR}/${art.id}.json`, JSON.stringify(clean(art), null, 2) + '\n');
        keep.add(art.id + '.json');
    }
    // Les brouillons et enquêtes programmées ne sont pas dans articles.json : on ne les supprime pas
    for (const f of readdirSync(DIR)) {
        if (!f.endsWith('.json') || keep.has(f)) continue;
        let art = {};
        try { art = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')); } catch (e) {}
        if (isPublic(art)) rmSync(`${DIR}/${f}`);
    }
    console.log(`📥 ${keep.size} enquête(s) importée(s) depuis articles.json vers ${DIR}/`);
} else {
    const articles = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
        const raw = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
        // Nouvelle enquête créée dans Pages CMS : l'identifiant = nom du fichier, inscrit dans le fichier
        if (!raw.id) {
            raw.id = f.replace(/\.json$/, '');
            writeFileSync(`${DIR}/${f}`, JSON.stringify(raw, null, 2) + '\n');
            console.log(`🆔 Identifiant attribué : ${raw.id}`);
        }
        const art = clean(raw);
        return art;
    }).sort(byDate);
    const pub = articles.filter(isPublic).map(a => { const c = { ...a }; delete c.brouillon; delete c.img_prompt; delete c.img_regen; return c; });
    writeFileSync('articles.json', JSON.stringify(pub, null, 2) + '\n');
    console.log(`📰 articles.json reconstruit : ${pub.length} enquête(s) publiée(s) (date du jour : ${TODAY})`);
    for (const a of articles.filter(isDraft)) console.log(`   ✏️  brouillon : ${a.title || a.id}`);
    for (const a of articles.filter(a => !isDraft(a) && isScheduled(a))) console.log(`   ⏰ programmée le ${a.published} : ${a.title || a.id}`);
}
