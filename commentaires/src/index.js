// =====================================================================
// Commentaires du Blog des Vérités Cachées — Cloudflare Worker
// Stockage : un Durable Object avec base SQLite intégrée (offre gratuite,
// aucune base à créer à la main).
//
// API publique
//   GET  /comments?page=<id>          → commentaires approuvés d'une enquête
//   GET  /counts?pages=<id1>,<id2>    → nombre de commentaires approuvés par enquête
//   POST /comments                    → nouveau commentaire (en attente de modération)
//        { page, name, body, website } (website = piège à robots, doit rester vide)
//
// API de modération (en-tête  Authorization: Bearer <ADMIN_TOKEN>)
//   GET  /admin/comments?status=pending|approved   → liste
//   POST /admin/moderate  { id, action: "approve" | "delete" }
//   POST /admin/reply     { page, body }           → réponse « La Rédaction », publiée directement
//   POST /admin/votes/set { page, up, down, onlyIfEmpty? } → fixer / importer les totaux de votes
//
// Votes (« Cette enquête vous a-t-elle éveillé ? »)
//   GET  /votes?pages=<id1>,<id2>     → { votes: { id: { up, down } } }
//   POST /votes { page, type: "up"|"down" } → un seul vote par personne et par enquête
//
// Variables / secrets (wrangler)
//   ADMIN_TOKEN       (secret)  mot de passe de modération
//   ALLOWED_ORIGINS   (var)     origines autorisées, séparées par des virgules
//   DISCORD_WEBHOOK   (secret, facultatif) notification à chaque nouveau commentaire
//   AUTO_APPROVE      (var, facultatif) "true" pour publier sans modération
// =====================================================================
import { DurableObject } from 'cloudflare:workers';

const LIMITS = { name: 40, body: 2000, perWindow: 3, windowMs: 10 * 60 * 1000 };

export class CommentStore extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page TEXT NOT NULL,
            name TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            is_admin INTEGER NOT NULL DEFAULT 0,
            ip_hash TEXT,
            created INTEGER NOT NULL
        )`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_page_status ON comments(page, status)`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_ip_created ON comments(ip_hash, created)`);
        // Votes : totaux par enquête + registre « qui a déjà voté » (empreintes non réversibles)
        this.sql.exec(`CREATE TABLE IF NOT EXISTS votes (
            page TEXT PRIMARY KEY, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS voters (
            page TEXT NOT NULL, voter TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (page, voter))`);
        this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_voters_voter ON voters(voter, created)`);
    }

    voteTotals(pages) {
        const out = {};
        for (const p of pages) out[p] = { up: 0, down: 0 };
        if (!pages.length) return out;
        const marks = pages.map(() => '?').join(',');
        for (const r of this.sql.exec(`SELECT page, up, down FROM votes WHERE page IN (${marks})`, ...pages).toArray())
            out[r.page] = { up: r.up, down: r.down };
        return out;
    }

    // Renvoie { ok, already, limited, totals }
    vote(page, type, voter) {
        const now = Date.now();
        const recent = this.sql.exec(`SELECT COUNT(*) AS n FROM voters WHERE voter = ? AND created > ?`, voter, now - 3600 * 1000).one().n;
        const done = this.sql.exec(`SELECT 1 FROM voters WHERE page = ? AND voter = ?`, page, voter).toArray().length > 0;
        if (!done && recent < 60) {
            this.sql.exec(`INSERT INTO voters (page, voter, created) VALUES (?, ?, ?)`, page, voter, now);
            this.sql.exec(`INSERT INTO votes (page, up, down) VALUES (?, 0, 0) ON CONFLICT(page) DO NOTHING`, page);
            this.sql.exec(`UPDATE votes SET ${type === 'up' ? 'up = up + 1' : 'down = down + 1'} WHERE page = ?`, page);
        }
        return { ok: !done && recent < 60, already: done, limited: !done && recent >= 60, totals: this.voteTotals([page])[page] };
    }

    setVotes(page, up, down, onlyIfEmpty) {
        const cur = this.voteTotals([page])[page];
        if (onlyIfEmpty && (cur.up > 0 || cur.down > 0)) return { skipped: true, totals: cur };
        this.sql.exec(`INSERT INTO votes (page, up, down) VALUES (?, ?, ?)
                       ON CONFLICT(page) DO UPDATE SET up = excluded.up, down = excluded.down`, page, up, down);
        if (up === 0 && down === 0) this.sql.exec(`DELETE FROM voters WHERE page = ?`, page);
        return { skipped: false, totals: { up, down } };
    }

    list(page) {
        return this.sql.exec(
            `SELECT id, name, body, is_admin, created FROM comments
             WHERE page = ? AND status = 'approved' ORDER BY created ASC LIMIT 500`, page).toArray();
    }

    counts(pages) {
        const out = {};
        for (const p of pages) out[p] = 0;
        if (!pages.length) return out;
        const marks = pages.map(() => '?').join(',');
        for (const r of this.sql.exec(
            `SELECT page, COUNT(*) AS n FROM comments WHERE status = 'approved' AND page IN (${marks}) GROUP BY page`,
            ...pages).toArray()) out[r.page] = r.n;
        return out;
    }

    recentFromIp(ipHash, since) {
        return this.sql.exec(`SELECT COUNT(*) AS n FROM comments WHERE ip_hash = ? AND created > ?`, ipHash, since).one().n;
    }

    add({ page, name, body, status, isAdmin, ipHash }) {
        const created = Date.now();
        this.sql.exec(
            `INSERT INTO comments (page, name, body, status, is_admin, ip_hash, created) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            page, name, body, status, isAdmin ? 1 : 0, ipHash, created);
        // Les empreintes d'IP ne servent qu'à l'anti-spam : effacées au bout de 30 jours
        this.sql.exec(`UPDATE comments SET ip_hash = NULL WHERE created < ?`, created - 30 * 24 * 3600 * 1000);
        return this.sql.exec(`SELECT last_insert_rowid() AS id`).one().id;
    }

    adminList(status) {
        return this.sql.exec(
            `SELECT id, page, name, body, status, is_admin, created FROM comments
             WHERE status = ? ORDER BY created DESC LIMIT 300`, status).toArray();
    }

    moderate(id, action) {
        if (action === 'approve') this.sql.exec(`UPDATE comments SET status = 'approved' WHERE id = ?`, id);
        else if (action === 'delete') this.sql.exec(`DELETE FROM comments WHERE id = ?`, id);
        return true;
    }
}

// ---------------------------------------------------------------------

function cors(env, req) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    return {
        'Access-Control-Allow-Origin': ok ? origin : (allowed[0] || '*'),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

function json(data, status, headers) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    });
}

const validPage = p => typeof p === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(p);
const clean = (s, max) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);

async function sha256(text) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function isAdmin(req, env) {
    const h = req.headers.get('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!env.ADMIN_TOKEN || !token || token.length !== env.ADMIN_TOKEN.length) return false;
    // comparaison à temps constant
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
    return diff === 0;
}

async function notify(env, ctx, { page, name, body }) {
    if (!env.DISCORD_WEBHOOK) return;
    const site = String(env.ALLOWED_ORIGINS || '').split(',')[0].trim();
    ctx.waitUntil(fetch(env.DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: `💬 **Nouveau commentaire à modérer** de **${name.slice(0, 40)}** sur ${site}/articles/${page}.html\n>>> ${body.slice(0, 500)}\n\nModérer : ${site}/outils/moderation.html`,
            allowed_mentions: { parse: [] },
        }),
    }).catch(() => {}));
}

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const h = cors(env, req);
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

        const store = env.COMMENTS.get(env.COMMENTS.idFromName('global'));

        try {
            // --- Public : lecture ---
            if (req.method === 'GET' && url.pathname === '/comments') {
                const page = url.searchParams.get('page');
                if (!validPage(page)) return json({ error: 'page invalide' }, 400, h);
                const rows = await store.list(page);
                return json({ comments: rows }, 200, { ...h, 'Cache-Control': 'public, max-age=30' });
            }
            if (req.method === 'GET' && url.pathname === '/counts') {
                const pages = String(url.searchParams.get('pages') || '').split(',').filter(validPage).slice(0, 100);
                return json({ counts: await store.counts(pages) }, 200, { ...h, 'Cache-Control': 'public, max-age=60' });
            }

            // --- Public : votes ---
            if (req.method === 'GET' && url.pathname === '/votes') {
                const pages = String(url.searchParams.get('pages') || '').split(',').filter(validPage).slice(0, 200);
                return json({ votes: await store.voteTotals(pages) }, 200, { ...h, 'Cache-Control': 'no-store' });
            }
            if (req.method === 'POST' && url.pathname === '/votes') {
                let data;
                try { data = await req.json(); } catch (e) { return json({ error: 'requête invalide' }, 400, h); }
                if (!validPage(data.page) || !['up', 'down'].includes(data.type)) return json({ error: 'requête invalide' }, 400, h);
                const ip = req.headers.get('CF-Connecting-IP') || 'local';
                const ua = req.headers.get('User-Agent') || '';
                const voter = await sha256('vote|' + ip + '|' + ua + '|' + (env.ADMIN_TOKEN || 'sel'));
                const r = await store.vote(data.page, data.type, voter);
                if (r.limited) return json({ error: 'Trop de votes, patientez.', totals: r.totals }, 429, h);
                return json({ ok: r.ok, already: r.already, totals: r.totals }, r.already ? 409 : 200, h);
            }

            // --- Public : envoi ---
            if (req.method === 'POST' && url.pathname === '/comments') {
                let data;
                try { data = await req.json(); } catch (e) { return json({ error: 'requête invalide' }, 400, h); }
                // Piège à robots : un humain ne voit pas ce champ
                if (data.website) return json({ ok: true, status: 'pending' }, 200, h);
                const page = data.page;
                const name = clean(data.name, LIMITS.name);
                const body = clean(data.body, LIMITS.body);
                if (!validPage(page)) return json({ error: 'page invalide' }, 400, h);
                if (name.length < 2) return json({ error: 'Pseudo trop court (2 caractères minimum).' }, 400, h);
                if (body.length < 3) return json({ error: 'Témoignage trop court.' }, 400, h);
                if ((body.match(/https?:\/\//g) || []).length > 2) return json({ error: 'Trop de liens dans le message.' }, 400, h);

                const ip = req.headers.get('CF-Connecting-IP') || 'local';
                const ipHash = await sha256(ip + '|' + (env.ADMIN_TOKEN || 'sel'));
                if (await store.recentFromIp(ipHash, Date.now() - LIMITS.windowMs) >= LIMITS.perWindow) {
                    return json({ error: 'Trop de témoignages en peu de temps. ILS surveillent : patientez quelques minutes.' }, 429, h);
                }
                const status = env.AUTO_APPROVE === 'true' ? 'approved' : 'pending';
                const id = await store.add({ page, name, body, status, isAdmin: false, ipHash });
                if (status === 'pending') await notify(env, ctx, { page, name, body });
                return json({ ok: true, id, status }, 201, h);
            }

            // --- Modération ---
            if (url.pathname.startsWith('/admin/')) {
                if (!isAdmin(req, env)) return json({ error: 'non autorisé' }, 401, h);
                if (req.method === 'GET' && url.pathname === '/admin/comments') {
                    const status = url.searchParams.get('status') === 'approved' ? 'approved' : 'pending';
                    return json({ comments: await store.adminList(status) }, 200, h);
                }
                if (req.method === 'POST' && url.pathname === '/admin/moderate') {
                    const { id, action } = await req.json();
                    if (!Number.isInteger(id) || !['approve', 'delete'].includes(action)) return json({ error: 'requête invalide' }, 400, h);
                    await store.moderate(id, action);
                    return json({ ok: true }, 200, h);
                }
                if (req.method === 'POST' && url.pathname === '/admin/votes/set') {
                    const d = await req.json();
                    const up = Number(d.up), down = Number(d.down);
                    if (!validPage(d.page) || !Number.isInteger(up) || !Number.isInteger(down) || up < 0 || down < 0)
                        return json({ error: 'requête invalide' }, 400, h);
                    return json({ ok: true, ...(await store.setVotes(d.page, up, down, !!d.onlyIfEmpty)) }, 200, h);
                }
                if (req.method === 'POST' && url.pathname === '/admin/reply') {
                    const d = await req.json();
                    const page = d.page;
                    const body = clean(d.body, LIMITS.body);
                    if (!validPage(page) || body.length < 1) return json({ error: 'requête invalide' }, 400, h);
                    const id = await store.add({ page, name: 'La Rédaction', body, status: 'approved', isAdmin: true, ipHash: null });
                    return json({ ok: true, id }, 201, h);
                }
            }

            if (url.pathname === '/') return json({ service: 'commentaires-verites-cachees', ok: true }, 200, h);
            return json({ error: 'introuvable' }, 404, h);
        } catch (e) {
            return json({ error: 'erreur serveur' }, 500, h);
        }
    },
};
