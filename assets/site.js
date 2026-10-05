// ============================================================
// LE BLOG DES VÉRITÉS CACHÉES — moteur de publication statique
// ============================================================

// ---------- CONFIGURATION ----------
// Compteur de visites GoatCounter (gratuit, sans cookies) :
// 1. Créez un compte sur https://www.goatcounter.com (choisissez un code, ex: "veritescachees")
// 2. Renseignez ce code ci-dessous
// 3. Dans les paramètres GoatCounter, activez "Allow adding visitor counts on your website"
// Pour NE PAS compter vos propres visites : visitez une fois votre site avec
// #toggle-goatcounter à la fin de l'URL (ex: https://votre-site.fr/#toggle-goatcounter)
// → vos visites depuis ce navigateur ne seront plus comptées. Re-visitez la même URL pour réactiver.
const GOATCOUNTER_CODE = "veritescachees-endam";   // ex: "veritescachees"

// Commentaires : Worker Cloudflare maison (dossier commentaires/ du dépôt).
// L'adresse de l'API est écrite automatiquement dans /assets/comments-config.js au déploiement.
// Vide = commentaires désactivés.
const COMMENTS_API = (window.COMMENTS_API || '').replace(/\/+$/, '');

const FEED_PAGE_SIZE = 5;      // nb d'enquêtes par "page" dans le fil
const TOP_SIZE = 3;            // nb d'enquêtes dans le Top

// Votes partagés entre tous les visiteurs : même Worker Cloudflare que les commentaires
// (un vote par personne et par enquête, contrôlé côté serveur). Voir commentaires/src/index.js.
// -----------------------------------

// Cache mémoire des totaux de votes chargés depuis l'API : { id: {up, down} }
let voteTotals = {};
// État du service de votes : null = en cours de chargement, true = OK, false = injoignable
let votesOnline = null;

let articles = [];
let rubriques = [];   // chargées depuis /rubriques.json
let feedPage = 1;

// --- OUTILS ---

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function truncateTitle(title, max = 95) {
    if (title.length <= max) return title;
    const cut = title.substring(0, max);
    return cut.substring(0, cut.lastIndexOf(' ')) + '…';
}

function highlightTitle(title) {
    const t = truncateTitle(title);
    const sep = t.search(/[:!?]/);
    let head, tail;
    if (sep > 0 && sep < 55) {
        head = t.substring(0, sep + 1);
        tail = t.substring(sep + 1);
    } else {
        const words = t.split(' ');
        head = words.slice(0, 4).join(' ');
        tail = ' ' + words.slice(4).join(' ');
    }
    return '<span class="hl">' + esc(head) + '</span>' + esc(tail);
}

// Date affichée : champ « date » si rempli, sinon calculée depuis « published » (AAAA-MM-JJ)
// Numéro de dossier (purement décoratif), stable pour une enquête donnée.
// Même calcul que dans .github/scripts/generate_pages.mjs.
function dossierNo(id) {
    const digits = String(id).replace(/\D/g, '');
    if (digits.length >= 4) return digits.slice(-5);
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return String(h % 100000).padStart(5, '0');
}

function displayDate(art) {
    if (art.date) return art.date;
    if (!art.published) return '';
    const d = new Date(art.published + 'T12:00:00');
    if (isNaN(d)) return art.published;
    const str = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function todayFR() {
    const d = new Date();
    const str = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function allArticles() { return articles; }
function latestId() { return articles.length > 0 ? articles[0].id : null; }

// Cascade de chargement d'image : essaie le chemin tel quel, puis images/<nom>,
// puis <nom> à la racine, et enfin le logo. Tolère les erreurs de dossier/chemin.
function imgCandidates(raw) {
    const fallback = '/logo_chat_loupe.png';
    if (!raw) return [fallback];
    const base = raw.split('/').pop();              // nom de fichier seul
    // Chemins absolus : le site est aussi servi depuis /articles/<id>.html
    const abs = /^(https?:|data:|\/)/.test(raw) ? raw : '/' + raw;
    // Version WebP allégée (générée par la GitHub Action) en premier, l'original en secours
    const webp = /\.(jpe?g|png)$/i.test(base) && !/^(https?:|data:)/.test(raw)
        ? ['/images/webp/' + base.replace(/\.[^.]+$/, '.webp')] : [];
    const list = [...webp, abs, '/images/' + base, '/' + base, fallback];
    // déduplique en gardant l'ordre
    return list.filter((v, i) => list.indexOf(v) === i);
}

// Construit l'attribut onerror qui passe au candidat suivant à chaque échec
function imgTag(raw, attrs) {
    const cands = imgCandidates(raw);
    const json = JSON.stringify(cands).replace(/"/g, '&quot;');
    const onerr = "(function(el){var c=" + json + ";el.__i=(el.__i==null?0:el.__i+1);" +
                  "if(el.__i<c.length){el.src=c[el.__i];}})(this)";
    return '<img src="' + esc(cands[0]) + '" onerror="' + onerr + '" ' + (attrs || '') + '>';
}

function voteScore(art) {
    // Totaux partagés chargés depuis l'API (cache mémoire), + le vote local non encore
    // reflété n'est pas nécessaire ici car l'API renvoie déjà le total à jour après un hit.
    const t = voteTotals[art.id] || { up: 0, down: 0 };
    return { up: t.up || 0, down: t.down || 0, score: (t.up || 0) - (t.down || 0) };
}

// Charge les totaux up/down de tous les articles affichés et rafraîchit l'UI
async function loadVoteTotals() {
    let ok = false;
    if (COMMENTS_API && articles.length) {
        try {
            const ids = articles.map(a => a.id).join(',');
            const r = await fetch(COMMENTS_API + '/votes?pages=' + encodeURIComponent(ids), { signal: AbortSignal.timeout(6000) });
            if (r.ok) {
                const { votes } = await r.json();
                for (const art of articles) voteTotals[art.id] = votes[art.id] || { up: 0, down: 0 };
                ok = true;
            }
        } catch (e) {}
    }
    // Service injoignable → on masque discrètement votes et classement plutôt que d'afficher des zéros
    votesOnline = articles.length === 0 || ok;
    document.body.classList.toggle('votes-off', !votesOnline);
    renderFeed();
    renderTop();
    // Met à jour les compteurs de l'article actuellement affiché, le cas échéant
    refreshOpenArticleVotes();
}

// Met à jour les nombres de votes affichés sur l'article ouvert (sans tout re-render)
function refreshOpenArticleVotes() {
    const bar = document.querySelector('.article-vote-bar');
    if (!bar || !bar.dataset.articleId) return;
    const t = voteTotals[bar.dataset.articleId] || { up: 0, down: 0 };
    const ups = bar.querySelector('[data-avote="up"] span');
    const downs = bar.querySelector('[data-avote="down"] span');
    if (ups) ups.textContent = t.up || 0;
    if (downs) downs.textContent = t.down || 0;
}

// URL canonique d'un article : sa vraie page /articles/<id>.html
function articleURL(id) {
    return window.location.origin + '/articles/' + encodeURIComponent(id) + '.html';
}

// URL de PARTAGE : pointe vers la vraie page HTML (/articles/<id>.html),
// pour que les aperçus sociaux (image + titre de l'enquête) soient corrects.
function articleShareURL(id) {
    return articleURL(id);
}

// --- RUBRIQUES, ENQUÊTES LIÉES, HASARD ---

function rubriqueOf(art) { return rubriques.find(r => r.slug === art.rubrique) || null; }
function rubriqueURL(slug) { return '/rubriques/' + encodeURIComponent(slug) + '.html'; }

// 3 enquêtes à lire ensuite : même rubrique d'abord, puis les plus récentes
function relatedArticles(art, n = 3) {
    const others = articles.filter(a => a.id !== art.id);
    const same = others.filter(a => art.rubrique && a.rubrique === art.rubrique);
    const rest = others.filter(a => !same.includes(a));
    return [...same, ...rest].slice(0, n);
}

function relatedHTML(art) {
    const list = relatedArticles(art);
    if (!list.length) return '';
    return '<section class="related"><h3>🕵️ Autres enquêtes à ne pas lire seul</h3><div class="related-grid">' +
        list.map(a =>
            '<a class="related-card" href="' + esc(articleURL(a.id)) + '" data-id="' + esc(a.id) + '">' +
                imgTag(a.img, 'alt="" loading="lazy" decoding="async"') +
                '<span class="related-title">' + esc(truncateTitle(a.title, 90)) + '</span>' +
            '</a>').join('') +
        '</div></section>';
}

function renderRubriquesBox() {
    const box = document.getElementById('rubriquesBox');
    if (!box || !rubriques.length) return;
    box.innerHTML = '<div class="top-box-header">📂 Rubriques</div><div class="rubriques-list">' +
        rubriques.map(r => {
            const n = articles.filter(a => a.rubrique === r.slug).length;
            return '<a href="' + rubriqueURL(r.slug) + '">' + esc(r.label) + ' <span>' + n + '</span></a>';
        }).join('') + '</div>';
    box.style.display = 'block';
}

function randomArticle() {
    const current = window.__ARTICLE_ID__ ||
        (location.pathname.match(/\/articles\/(.+)\.html$/) || [])[1];
    const pool = articles.filter(a => a.id !== current);
    if (!pool.length) return;
    displayArticle(pool[Math.floor(Math.random() * pool.length)].id, true);
}

// --- CHARGEMENT + ROUTAGE PAR URL ---

async function loadArticles() {
    try {
        const resp = await fetch('/articles.json?v=' + Date.now());
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        articles = await resp.json();
        try {
            const rr = await fetch('/rubriques.json');
            if (rr.ok) rubriques = await rr.json();
        } catch (e) { rubriques = []; }
    } catch (err) {
        console.error('Impossible de charger articles.json :', err);
        articles = [];
        document.getElementById('storiesFeed').innerHTML =
            '<div class="load-error">⚠️ ERREUR DE TRANSMISSION : impossible de charger <strong>articles.json</strong>.<br><br>' +
            '— En ligne : vérifiez que <code>articles.json</code> est à la racine du dépôt et que son contenu est un JSON valide.<br>' +
            '— En local : lancez un mini-serveur (<code>python3 -m http.server</code>) au lieu d\'ouvrir le fichier directement.</div>';
        document.getElementById('articleViewer').innerHTML =
            '<div class="breaking-banner">Breaking News</div>' +
            '<div class="article-body"><p>La transmission a été interceptée... Réessayez plus tard.</p></div>';
        return;
    }

    // Tri automatique par date ISO "published" (plus récent en premier).
    // Les articles sans champ published gardent leur ordre et passent après.
    if (articles.some(a => a.published)) {
        articles.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    }

    renderTicker();
    renderTop();
    renderFeed();
    renderRubriquesBox();
    loadVoteTotals(); // charge les vrais totaux partagés depuis l'API (asynchrone)

    // Routage : ?article=id dans l'URL → affichage direct de l'enquête (lien partageable)
    // - page d'article générée : window.__ARTICLE_ID__ est injecté par generate_pages.mjs
    // - ancien lien index.html?article=id : toujours accepté, l'URL bascule ensuite sur /articles/<id>.html
    const params = new URLSearchParams(window.location.search);
    const wanted = window.__ARTICLE_ID__ || params.get('article');
    if (wanted && articles.some(a => a.id === wanted)) {
        displayArticle(wanted, true);
    } else if (params.has('hasard')) {
        randomArticle();
    } else {
        displayHome();
    }
}

// --- BANDEAU DÉFILANT ---

function renderTicker() {
    if (articles.length === 0) return;
    const bar = document.getElementById('tickerBar');
    const content = document.getElementById('tickerContent');
    const titles = articles.slice(0, 10).map(a => esc(truncateTitle(a.title, 80))).join(' &nbsp;⚡&nbsp; ');
    // Contenu doublé pour une boucle de défilement sans coupure
    content.innerHTML = titles + ' &nbsp;⚡&nbsp; ' + titles + ' &nbsp;⚡&nbsp; ';
    bar.style.display = 'flex';
}

// --- TOP DES ENQUÊTES (classement par votes) ---

function renderTop() {
    const box = document.getElementById('topBox');
    const list = document.getElementById('topList');
    // Classement affiché seulement une fois les vrais totaux chargés, et si le service répond
    if (articles.length < 2 || votesOnline !== true) { box.style.display = 'none'; return; }

    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    const ranked = [...articles]
        .map(a => ({ art: a, ...voteScore(a) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_SIZE);

    list.innerHTML = '';
    ranked.forEach((item, i) => {
        const row = document.createElement('div');
        row.className = 'top-row';
        row.innerHTML =
            '<span class="top-rank">' + (medals[i] || (i + 1) + '.') + '</span>' +
            '<span class="top-title">' + esc(truncateTitle(item.art.title, 65)) + '</span>' +
            '<span class="top-score">▲' + item.up + '</span>';
        row.addEventListener('click', () => displayArticle(item.art.id, true));
        list.appendChild(row);
    });
    box.style.display = 'block';
}

// --- ACCUEIL = DERNIER ARTICLE EN BREAKING NEWS ---

function displayHome() {
    // Depuis une page d'article, l'accueil est une autre page (balises SEO différentes)
    if (window.__ARTICLE_ID__) { window.location.href = '/'; return; }
    history.replaceState(null, '', '/'); // URL propre
    trackView('/');
    const viewer = document.getElementById('articleViewer');

    if (articles.length === 0) {
        viewer.innerHTML =
            '<div class="breaking-banner">Breaking News</div>' +
            '<div class="article-body"><p><strong>"Le Blog des Vérités Cachées"</strong> prépare sa première enquête. ' +
            'Puces 5G invisibles, mutants planqués dans la plomberie, lucioles drones biologiques... ' +
            'Le réel n\'a qu\'à bien se tenir.</p></div>';
        renderFeed();
        return;
    }

    // PAGE D'INTRO : la photo du dernier scoop en teaser (clic = lire l'enquête),
    // suivie du manifeste du blog. L'article complet ne s'affiche que sur clic.
    const art = articles[0];
    viewer.innerHTML =
        '<div class="breaking-banner">Breaking News</div>' +
        '<h2 class="article-headline home-headline" id="homeTitle">' + esc(art.title) + '</h2>' +
        '<div class="hero-visual no-overlay hero-clickable" id="homeHero" title="Lire l\'enquête complète">' +
            imgTag(art.img, 'alt="" fetchpriority="high" decoding="async"') +
            (art.classified ? '<span class="classified-stamp big">Classified</span>' : '') +
        '</div>' +
        '<p class="home-desc">' + esc(art.desc || '') + '</p>' +
        '<div class="studio-actions home-cta">' +
            '<button type="button" class="btn-submit" id="homeReadBtn">📰 Lire l\'enquête exclusive</button>' +
        '</div>' +
        '<div class="article-body">' +
            '<p>Vous en avez assez des versions officielles lisses et ennuyeuses ? Vous sentez que la vérité ' +
            'est plus tordue, plus folle, plus... réelle ? Vous êtes au bon endroit.</p>' +
            '<p><strong>"Le Blog des Vérités Cachées"</strong> plonge dans le quotidien secret de vos voisins ' +
            'pour révéler l\'incroyable complot qui se tisse sous nos yeux. Objets maudits, technologies ' +
            'suspectes, phénomènes inexpliqués et témoignages impossibles à ignorer... tout est là, mesuré ' +
            'et vérifié par l\'Investigateur Anonyme ! <strong>Entrez, si vous osez remettre en question le réel.</strong></p>' +
        '</div>' +
        '<div class="home-stats">' +
            '<div class="stat-box"><div class="stat-num">100%</div><div class="stat-label">de vérités vérifiées par nous-mêmes</div></div>' +
            '<div class="stat-box"><div class="stat-num">' + articles.length + '</div><div class="stat-label">enquête' + (articles.length > 1 ? 's' : '') + ' déclassifiée' + (articles.length > 1 ? 's' : '') + ' à ce jour</div></div>' +
            '<div class="stat-box"><div class="stat-num">0</div><div class="stat-label">fait validé par les médias officiels (ils sont compromis)</div></div>' +
        '</div>' +
        '<div class="home-quotes">' +
            '<h3>💬 Ils témoignent (anonymement)</h3>' +
            '<blockquote class="temoin">« Depuis que je suis vos recommandations et que j\'analyse mon environnement, ma femme me dit que j\'ai changé. Évidemment que j\'ai changé : je vois enfin les choses telles qu\'elles sont ! »<cite>— Un lecteur de la première heure</cite></blockquote>' +
            '<blockquote class="temoin">« J\'ai imprimé vos dossiers pour les distribuer dans les boîtes aux lettres de mon lotissement. La plupart des gens jettent, mais si on peut réveiller ne serait-ce que deux ou trois personnes, ça en vaut la peine. »<cite>— Un citoyen qui refuse de fermer les yeux</cite></blockquote>' +
            '<blockquote class="temoin">« J\'ai essayé d\'aborder vos théories pendant le repas de dimanche, mon beau-frère m\'a ri au nez en me disant que je devenais complètement fou. Tant pis pour les endormis. »<cite>— Martine, 52 ans, bienveillante mais incomprise</cite></blockquote>' +
            '<blockquote class="temoin">« Merci de donner une voix à ceux qui constatent les anomalies au quotidien. »<cite>— Patrice D., membre d\'un collectif d\'observation</cite></blockquote>' +
            '<blockquote class="temoin">« Ma femme me prend pour un fou quand j\'essaie de lui expliquer comment le système fonctionne vraiment. Heureusement que votre site existe, on se sent moins seul face au déni général. »<cite>— Un citoyen qui a ouvert les yeux</cite></blockquote>' +
        '</div>';

    document.getElementById('homeHero').addEventListener('click', () => displayArticle(art.id, false));
    document.getElementById('homeReadBtn').addEventListener('click', () => displayArticle(art.id, false));
    document.getElementById('homeTitle').addEventListener('click', () => displayArticle(art.id, false));

    renderFeed();
}

// --- FIL D'ACTUALITÉS paginé ---

function renderFeed() {
    const feed = document.getElementById('storiesFeed');
    feed.innerHTML = "";

    const list = articles; // tous les articles, y compris le Breaking News en tête

    if (list.length === 0) {
        feed.innerHTML = '<div class="load-error" style="background:#f4f4f4;border-color:#999;">' +
            'D\'autres enquêtes sont en cours d\'infiltration... Le fil se remplira à chaque nouvelle publication. 🕵️</div>';
        return;
    }

    const totalPages = Math.ceil(list.length / FEED_PAGE_SIZE);
    if (feedPage > totalPages) feedPage = totalPages;
    if (feedPage < 1) feedPage = 1;
    const start = (feedPage - 1) * FEED_PAGE_SIZE;
    const visible = list.slice(start, start + FEED_PAGE_SIZE);

    visible.forEach((art, idx) => {
        const isUne = (art.id === latestId());
        const card = document.createElement('div');
        card.className = 'feed-card' + (isUne ? ' is-une' : '');
        card.addEventListener('click', () => displayArticle(art.id, true));

        const v = voteScore(art);
        const hasVoted = !!localStorage.getItem('vote_' + art.id);
        const activeUp = localStorage.getItem('vote_' + art.id) === 'up' ? 'active-up' : '';
        const activeDown = localStorage.getItem('vote_' + art.id) === 'down' ? 'active-down' : '';
        const votedCls = hasVoted ? ' voted' : '';
        const stamp = art.classified ? '<span class="classified-stamp">Classified</span>' : '';
        const uneBadge = isUne ? '<span class="feed-une-badge">★ À la une</span>' : '';

        card.innerHTML =
            '<div class="feed-img-area">' + imgTag(art.img, 'alt="Illustration" loading="lazy" decoding="async"') + '</div>' +
            '<div class="feed-content">' +
                uneBadge +
                '<div class="feed-title">' + highlightTitle(art.title) + '</div>' +
                '<div class="feed-desc">' + esc(art.desc) + '</div>' +
                '<div class="vote-system' + votedCls + '">' +
                    '<button class="vote-btn upvote ' + activeUp + '" data-vote="up">👍 <span class="count">' + v.up + '</span></button>' +
                    '<button class="vote-btn downvote ' + activeDown + '" data-vote="down">👎 <span class="count">' + v.down + '</span></button>' +
                '</div>' +
            '</div>' + stamp;

        card.querySelectorAll('.vote-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (localStorage.getItem('vote_' + art.id)) return; // déjà voté
                registerVote(art.id, btn.dataset.vote);
            });
        });

        feed.appendChild(card);
    });

    // Pagination numérotée : ‹ 1 2 3 › (remplace le contenu, la page ne s'allonge pas)
    if (totalPages > 1) {
        const pager = document.createElement('div');
        pager.className = 'feed-pager';

        const mkBtn = (label, page, disabled, active) => {
            const b = document.createElement('button');
            b.className = 'pager-btn' + (active ? ' active' : '');
            b.textContent = label;
            b.disabled = !!disabled;
            if (!disabled && !active) {
                b.addEventListener('click', () => {
                    feedPage = page;
                    renderFeed();
                    document.getElementById('storiesFeed').scrollIntoView({ block: 'start' });
                });
            }
            return b;
        };

        pager.appendChild(mkBtn('‹', feedPage - 1, feedPage === 1, false));
        for (let p = 1; p <= totalPages; p++) {
            pager.appendChild(mkBtn(String(p), p, false, p === feedPage));
        }
        pager.appendChild(mkBtn('›', feedPage + 1, feedPage === totalPages, false));

        feed.appendChild(pager);
    }
}

// --- AFFICHAGE D'UN ARTICLE ---

function displayArticle(id, isArchive) {
    const art = allArticles().find(a => a.id === id);
    const viewer = document.getElementById('articleViewer');
    if (!art) return;

    // URL partageable (sauf brouillons)
    history.replaceState(null, '', '/articles/' + encodeURIComponent(art.id) + '.html');
    document.title = art.title + ' | Le Blog des Vérités Cachées';
    trackView('/articles/' + art.id + '.html');

    let interviewHTML = "";
    if (art.interview && art.interview.length > 0) {
        interviewHTML = '<div class="interview-box"><h3>L\'Interview Exclusive</h3>';
        art.interview.forEach(row => {
            interviewHTML += '<div class="interview-line"><strong>' + esc(row.q) + '</strong>' + esc(row.a) + '</div>';
        });
        interviewHTML += '</div>';
    }

    const noticeHTML = art.notice ? '<div class="redac-notice">⚠️ L\'AVIS DE LA RÉDACTION : ' + esc(art.notice) + '</div>' : '';

    let banner;
    if (isArchive && art.id !== latestId()) {
        banner = '<div class="archive-banner">Archive déclassifiée</div>';
    } else {
        banner = '<div class="breaking-banner">Breaking News</div>';
    }

    const stampBig = art.classified ? '<span class="classified-stamp big">Classified</span>' : '';

    // Boutons de partage (pas sur les brouillons)
    let shareHTML = '';
    let voteHTML = '';
    {
        const url = articleShareURL(art.id);
        const shareText = '🎭 [Parodie] ' + art.title;

        // Votes sur l'article principal
        const v = voteScore(art);
        const hasVoted = !!localStorage.getItem('vote_' + art.id);
        const aUp = localStorage.getItem('vote_' + art.id) === 'up' ? 'active-up' : '';
        const aDown = localStorage.getItem('vote_' + art.id) === 'down' ? 'active-down' : '';
        const voteLabel = hasVoted ? 'Merci, votre voix est enregistrée !' : 'Cette enquête vous a-t-elle éveillé ?';
        voteHTML =
            '<div class="article-vote-bar' + (hasVoted ? ' voted' : '') + '" data-article-id="' + esc(art.id) + '">' +
                '<span class="article-vote-label">' + voteLabel + '</span>' +
                '<button class="article-vote-btn ' + aUp + '" data-avote="up">👍 <span>' + v.up + '</span></button>' +
                '<button class="article-vote-btn ' + aDown + '" data-avote="down">👎 <span>' + v.down + '</span></button>' +
            '</div>';

        shareHTML =
            '<div class="share-bar">' +
                '<span class="share-label">📢 Diffuser la vérité :</span>' +
                '<a class="share-btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText) + '&url=' + encodeURIComponent(url) + '">𝕏</a>' +
                '<a class="share-btn" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(shareText + ' ' + url) + '">WhatsApp</a>' +
                '<a class="share-btn" target="_blank" rel="noopener" href="https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(shareText) + '">Telegram</a>' +
                '<button class="share-btn" onclick="copyArticleLink(\'' + esc(art.id) + '\')">🔗 Copier le lien</button>' +
            '</div>';
    }

    const rub = rubriqueOf(art);
    const rubHTML = rub ? '<a class="rubrique-chip" href="' + rubriqueURL(rub.slug) + '">' + esc(rub.label) + '</a>' : '';

    viewer.innerHTML =
        rubHTML +
        '<div class="dossier-line"><strong>Dossier n° ' + dossierNo(art.id) + '</strong>' +
            (art.location ? ' · ' + esc(art.location) : '') +
            ' · ' + esc(displayDate(art)) +
            ' · Par ' + esc(art.author || "L'Investigateur Anonyme") + '</div>' +
        banner +
        '<h1 class="article-headline">' + esc(art.title) + '</h1>' +
        '<div class="hero-visual no-overlay">' +
            imgTag(art.img, 'alt="" fetchpriority="high" decoding="async"') +
            stampBig +
        '</div>' +
        '<div class="article-body">' +
            '<p>' + esc(art.intro) + '</p>' +
            interviewHTML +
            noticeHTML +
        '</div>' +
        voteHTML +
        shareHTML +
        relatedHTML(art) +
        '<div class="comments-zone" id="commentsZone"></div>';

    // Enquêtes liées : navigation sans rechargement
    viewer.querySelectorAll('.related-card').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.metaKey || e.ctrlKey) return;   // ouverture dans un nouvel onglet : on laisse faire
            e.preventDefault();
            displayArticle(card.dataset.id, true);
        });
    });

    // Brancher les votes de l'article principal
    viewer.querySelectorAll('.article-vote-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (localStorage.getItem('vote_' + art.id)) return; // déjà voté
            await registerVote(art.id, btn.dataset.avote);
            // Marque visuellement et verrouille la barre
            const bar = btn.closest('.article-vote-bar');
            if (bar) {
                bar.classList.add('voted');
                const label = bar.querySelector('.article-vote-label');
                if (label) label.textContent = 'Merci, votre voix est enregistrée !';
            }
            btn.classList.add(btn.dataset.avote === 'up' ? 'active-up' : 'active-down');
        });
    });

    loadComments(art);

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function copyArticleLink(id) {
    const url = articleShareURL(id);
    navigator.clipboard.writeText(url)
        .then(() => alert('Lien copié ! Diffusez la vérité. 📡\n' + url))
        .catch(() => prompt('Copiez le lien manuellement :', url));
}

function copyRssLink() {
    const url = window.location.origin + '/feed.xml';
    navigator.clipboard.writeText(url)
        .then(() => alert('Lien du flux copié ! Collez-le dans votre lecteur RSS (Feedly, Inoreader...). 📡\n' + url))
        .catch(() => prompt('Copiez le lien du flux manuellement :', url));
}

// --- COMMENTAIRES (« Témoignages des Éveillés ») ---

function formatCommentDate(ms) {
    return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function commentHTML(c) {
    return '<div class="comment' + (c.is_admin ? ' comment-admin' : '') + '">' +
        '<div class="comment-head"><strong>' + esc(c.name) + '</strong>' +
        (c.is_admin ? ' <span class="comment-badge">✔ Rédaction</span>' : '') +
        '<span class="comment-date">' + formatCommentDate(c.created) + '</span></div>' +
        '<div class="comment-body">' + esc(c.body).replace(/\n/g, '<br>') + '</div></div>';
}

async function loadComments(art) {
    const zone = document.getElementById('commentsZone');
    if (!zone || !COMMENTS_API) return;
    const savedName = (() => { try { return localStorage.getItem('comment_name') || ''; } catch (e) { return ''; } })();
    zone.innerHTML =
        '<h3>💬 Témoignages des Éveillés</h3>' +
        '<div class="comment-list" id="commentList"><p class="comment-empty">Chargement des témoignages…</p></div>' +
        '<form class="comment-form" id="commentForm" novalidate>' +
            '<label for="cName">Pseudo</label>' +
            '<input id="cName" name="name" maxlength="40" required autocomplete="nickname" placeholder="Ex : Un citoyen éveillé" value="' + esc(savedName) + '">' +
            '<label for="cBody">Votre témoignage</label>' +
            '<textarea id="cBody" name="body" maxlength="2000" required rows="4" placeholder="Vous aussi, vous avez remarqué quelque chose ?"></textarea>' +
            // Piège à robots : invisible pour les humains
            '<div class="hp" aria-hidden="true"><label>Site web <input name="website" tabindex="-1" autocomplete="off"></label></div>' +
            '<div class="comment-actions"><button type="submit" class="btn-submit">📡 Transmettre</button>' +
            '<span class="comment-note">Témoignages relus par la Rédaction avant publication.</span></div>' +
            '<p class="comment-msg" id="commentMsg" role="status"></p>' +
        '</form>';

    const list = document.getElementById('commentList');
    try {
        const r = await fetch(COMMENTS_API + '/comments?page=' + encodeURIComponent(art.id), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const { comments } = await r.json();
        list.innerHTML = comments.length
            ? comments.map(commentHTML).join('')
            : '<p class="comment-empty">Aucun témoignage pour l\'instant. Soyez le premier à briser le silence.</p>';
    } catch (e) {
        list.innerHTML = '<p class="comment-empty">Les témoignages sont momentanément brouillés. Réessayez plus tard.</p>';
    }

    const form = document.getElementById('commentForm');
    const msg = document.getElementById('commentMsg');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = form.elements;
        const name = f.namedItem('name').value.trim(), body = f.namedItem('body').value.trim();
        if (name.length < 2) { msg.textContent = 'Pseudo trop court (2 caractères minimum).'; msg.className = 'comment-msg err'; return; }
        if (body.length < 3) { msg.textContent = 'Votre témoignage est un peu court.'; msg.className = 'comment-msg err'; return; }
        const btn = form.querySelector('button'); btn.disabled = true;
        msg.textContent = 'Transmission cryptée en cours…'; msg.className = 'comment-msg';
        try {
            const r = await fetch(COMMENTS_API + '/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page: art.id, name, body, website: f.namedItem('website').value }),
                signal: AbortSignal.timeout(10000)
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || 'Échec de la transmission.');
            try { localStorage.setItem('comment_name', name); } catch (err) {}
            f.namedItem('body').value = '';
            msg.textContent = d.status === 'approved'
                ? '✅ Témoignage publié. ILS vont adorer.'
                : '✅ Témoignage reçu ! Il sera publié après vérification par la Rédaction.';
            msg.className = 'comment-msg ok';
            if (d.status === 'approved') loadComments(art);
        } catch (err) {
            msg.textContent = '⚠️ ' + (err.name === 'TimeoutError' ? 'La transmission a été interceptée. Réessayez.' : err.message);
            msg.className = 'comment-msg err';
        } finally {
            btn.disabled = false;
        }
    });
}

// --- VOTES PARTAGÉS (compteurs en ligne, communs à tous les visiteurs) ---
// Le localStorage ne sert qu'à mémoriser CE QUE ce visiteur a déjà voté
// (pour éviter les votes multiples et afficher le bouton actif).

async function registerVote(articleId, type) {
    const storageKey = 'vote_' + articleId;
    const currentVote = localStorage.getItem(storageKey);

    // PROTECTION ANTI-REVOTE : ce navigateur a déjà voté pour cet article → on bloque.
    // Couvre les boutons du fil ET ceux de l'article (un seul vote par navigateur/article).
    if (currentVote) {
        return;
    }

    // S'assurer que le cache existe
    if (!voteTotals[articleId]) voteTotals[articleId] = { up: 0, down: 0 };

    // Marque le vote AVANT l'appel réseau, pour bloquer les clics rapides répétés
    localStorage.setItem(storageKey, type);

    // Enregistre le vote en ligne (le serveur refuse un 2e vote de la même personne)
    try {
        const r = await fetch(COMMENTS_API + '/votes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: articleId, type }),
            signal: AbortSignal.timeout(6000)
        });
        const d = await r.json().catch(() => ({}));
        if (d.totals) voteTotals[articleId] = d.totals;
        else voteTotals[articleId][type] = (voteTotals[articleId][type] || 0) + 1;
    } catch (e) {
        // En cas d'échec réseau, on incrémente localement pour le retour visuel
        voteTotals[articleId][type] = (voteTotals[articleId][type] || 0) + 1;
    }

    renderFeed();
    renderTop();
    refreshOpenArticleVotes();
}

// --- COMPTEUR DE VISITES (GoatCounter) ---

// Compte une vue GoatCounter (ignorée si le script n'est pas chargé ou si le visiteur est exclu)
let lastTracked = null;
function trackView(path) {
    if (path === lastTracked) return;
    if (!window.goatcounter || typeof window.goatcounter.count !== 'function') return;
    lastTracked = path;
    window.goatcounter.count({ path: path, title: document.title });
}

function initVisitCounter() {
    if (!GOATCOUNTER_CODE) return;

    // Bascule "ne pas me compter" : visitez votre site avec #toggle-goatcounter
    if (window.location.hash === '#toggle-goatcounter') {
        if (localStorage.getItem('skipgc') === 't') {
            localStorage.removeItem('skipgc');
            alert('👁 Vos visites sont à nouveau COMPTÉES sur ce navigateur.');
        } else {
            localStorage.setItem('skipgc', 't');
            alert('🕵️ Vos visites ne sont PLUS comptées sur ce navigateur (mode Investigateur).');
        }
    }

    // Comptage de la visite (sauf si exclu)
    if (localStorage.getItem('skipgc') !== 't') {
        // Comptage manuel : une vue par page réellement affichée (accueil, chaque enquête)
        window.goatcounter = { no_onload: true };
        const s = document.createElement('script');
        s.onload = () => trackView(location.pathname);
        s.async = true;
        s.src = 'https://gc.zgo.at/count.js';
        s.setAttribute('data-goatcounter', 'https://' + GOATCOUNTER_CODE + '.goatcounter.com/count');
        document.body.appendChild(s);
    }

    // Affichage du total (nécessite d'activer "visitor counts" dans les réglages GoatCounter)
    fetch('https://' + GOATCOUNTER_CODE + '.goatcounter.com/counter/TOTAL.json')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (data && data.count) {
                const el = document.getElementById('visitCounter');
                el.textContent = '👁 ' + String(data.count).trim() + ' esprits éveillés ont consulté ce site';
                el.style.display = 'block';
            }
        })
        .catch(() => {});
}

// --- INIT ---

document.addEventListener("DOMContentLoaded", () => {
    loadArticles();
    initVisitCounter();
    document.querySelectorAll('[data-random]').forEach(b => b.addEventListener('click', (e) => {
        e.preventDefault();
        randomArticle();
    }));

    // Lien "Partager sur X" du pied de page → partage le site
    const sx = document.getElementById('socialX');
    if (sx) {
        const siteUrl = window.location.origin + '/';
        sx.href = 'https://twitter.com/intent/tweet?text=' +
            encodeURIComponent('Le Blog des Vérités Cachées — La voix de ceux qui savent') +
            '&url=' + encodeURIComponent(siteUrl);
    }
});
