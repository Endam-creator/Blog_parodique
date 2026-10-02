// Migration unique : copie les totaux de votes de l'ancien service CountAPI vers le Worker.
// N'écrase jamais une enquête qui a déjà des votes dans le Worker (onlyIfEmpty) : relancer est sans risque.
import { readFileSync } from 'node:fs';

const OLD = 'https://countapi.mileshilliard.com/api/v1/get/lvc_endam_';
const API = process.env.API, TOKEN = process.env.ADMIN_TOKEN;
if (!API || !TOKEN) { console.log('API ou ADMIN_TOKEN absent : import ignoré.'); process.exit(0); }

async function old(id, type) {
    try {
        const r = await fetch(OLD + encodeURIComponent(id) + '_' + type, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return 0;
        return parseInt((await r.json()).value, 10) || 0;
    } catch (e) { return null; }
}

const articles = JSON.parse(readFileSync('articles.json', 'utf8'));
let imported = 0;
for (const a of articles) {
    const up = await old(a.id, 'up'), down = await old(a.id, 'down');
    if (up === null || down === null) { console.log(`⚠️ ancien service injoignable pour ${a.id}`); continue; }
    if (!up && !down) continue;
    const r = await fetch(API + '/admin/votes/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ page: a.id, up, down, onlyIfEmpty: true })
    });
    const d = await r.json().catch(() => ({}));
    console.log(`${d.skipped ? '⏭️  déjà présent' : '✅ importé'} ${a.id} : 👍 ${up} 👎 ${down}`);
    if (!d.skipped) imported++;
}
console.log(`${imported} enquête(s) importée(s).`);
