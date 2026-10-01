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
const GOATCOUNTER_CODE = "endam-digital";   // ex: "veritescachees"

// Commentaires Cusdis (gratuit, sans inscription des visiteurs, sans compte GitHub) :
// 1. Créez un compte gratuit sur https://cusdis.com
// 2. Ajoutez un site ("Add new website") → Cusdis vous donne un "App ID" (un UUID)
// 3. Collez cet App ID ci-dessous. Laissez vide pour désactiver les commentaires.
// Les visiteurs commentent avec un simple pseudo. Vous validez/supprimez les
// commentaires depuis votre tableau de bord Cusdis (et par email).
const CUSDIS_APP_ID = "804824ac-4fc7-4325-9f8c-7f7666f90117";   // ex: "a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

const FEED_PAGE_SIZE = 5;      // nb d'enquêtes par "page" dans le fil
const TOP_SIZE = 3;            // nb d'enquêtes dans le Top

// Votes partagés entre tous les visiteurs (CountAPI de Miles Hilliard, gratuit, sans clé).
// Le préfixe doit être UNIQUE à ton site pour ne pas entrer en collision avec d'autres.
// Ne le change plus après la mise en ligne, sinon les compteurs repartent de zéro.
const VOTE_API = "https://countapi.mileshilliard.com/api/v1";
const VOTE_PREFIX = "lvc_endam_";   // lvc = Le blog des Vérités Cachées
// -----------------------------------

// Cache mémoire des totaux de votes chargés depuis l'API : { id: {up, down} }
let voteTotals = {};

let articles = [];
let workingArticles = null;
let draftArticles = [];
let editingId = null;
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

function todayFR() {
    const d = new Date();
    const str = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function allArticles() { return [...draftArticles, ...articles]; }
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

// Clé unique d'un compteur pour un article donné
function voteKey(id, type) {
    return VOTE_PREFIX + id + '_' + type;
}

// Lit un compteur en ligne sans l'incrémenter (renvoie 0 si la clé n'existe pas encore)
async function fetchCount(id, type) {
    try {
        const r = await fetch(VOTE_API + '/get/' + encodeURIComponent(voteKey(id, type)));
        if (!r.ok) return 0;
        const d = await r.json();
        return parseInt(d.value, 10) || 0;
    } catch (e) {
        return 0;
    }
}

// Incrémente un compteur de +1 et renvoie la nouvelle valeur
async function hitCount(id, type) {
    try {
        const r = await fetch(VOTE_API + '/hit/' + encodeURIComponent(voteKey(id, type)));
        if (!r.ok) return null;
        const d = await r.json();
        return parseInt(d.value, 10);
    } catch (e) {
        return null;
    }
}

// Charge les totaux up/down de tous les articles affichés et rafraîchit l'UI
async function loadVoteTotals() {
    await Promise.all(articles.map(async (art) => {
        const [up, down] = await Promise.all([
            fetchCount(art.id, 'up'),
            fetchCount(art.id, 'down')
        ]);
        voteTotals[art.id] = { up, down };
    }));
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

// --- CHARGEMENT + ROUTAGE PAR URL ---

async function loadArticles() {
    try {
        const resp = await fetch('/articles.json?v=' + Date.now());
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        articles = await resp.json();
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
    loadVoteTotals(); // charge les vrais totaux partagés depuis l'API (asynchrone)

    // Routage : ?article=id dans l'URL → affichage direct de l'enquête (lien partageable)
    // - page d'article générée : window.__ARTICLE_ID__ est injecté par generate_pages.mjs
    // - ancien lien index.html?article=id : toujours accepté, l'URL bascule ensuite sur /articles/<id>.html
    const params = new URLSearchParams(window.location.search);
    const wanted = window.__ARTICLE_ID__ || params.get('article');
    if (wanted && articles.some(a => a.id === wanted)) {
        displayArticle(wanted, true);
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
    if (articles.length < 2) { box.style.display = 'none'; return; }

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
    draftArticles = [];
    history.replaceState(null, '', '/'); // URL propre
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
        '<div class="hero-visual hero-clickable" id="homeHero" title="Lire l\'enquête complète">' +
            imgTag(art.img, 'alt="' + esc(art.title) + '" fetchpriority="high" decoding="async"') +
            '<div class="hero-title-overlay"><h2>' + esc(art.title) +
                ' <span class="read-more">(Lire l\'enquête exclusive)</span></h2></div>' +
        '</div>' +
        '<div class="article-body">' +
            '<p>Vous en avez assez des versions officielles lisses et ennuyeuses ? Vous sentez que la vérité ' +
            'est plus tordue, plus folle, plus... réelle ? Vous êtes au bon endroit.</p>' +
            '<p><strong>"Le Blog des Vérités Cachées"</strong> plonge dans le quotidien secret de vos voisins ' +
            'pour révéler l\'incroyable complot qui se tisse sous nos yeux. Objets maudits, technologies ' +
            'suspectes, phénomènes inexpliqués et témoignages impossibles à ignorer... tout est là, mesuré ' +
            'et vérifié par l\'Investigateur Anonyme ! <strong>Entrez, si vous osez remettre en question le réel.</strong></p>' +
        '</div>' +
        '<div class="studio-actions" style="margin-top:14px;">' +
            '<button type="button" class="btn-submit" id="homeReadBtn">📰 Lire la dernière enquête</button>' +
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
    if (!art._draft) {
        history.replaceState(null, '', '/articles/' + encodeURIComponent(art.id) + '.html');
        document.title = art.title + ' | Le Blog des Vérités Cachées';
    }

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
    if (art._draft) {
        banner = '<div class="draft-banner">Aperçu local — non publié</div>';
    } else if (isArchive && art.id !== latestId()) {
        banner = '<div class="archive-banner">Archive déclassifiée</div>';
    } else {
        banner = '<div class="breaking-banner">Breaking News</div>';
    }

    const stampBig = art.classified ? '<span class="classified-stamp big">Classified</span>' : '';

    // Boutons de partage (pas sur les brouillons)
    let shareHTML = '';
    let voteHTML = '';
    if (!art._draft) {
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

    viewer.innerHTML =
        '<div class="meta-data">' +
            'LE BLOG DES VÉRITÉS CACHÉES – La voix de ceux qui savent<br>' +
            'Date de publication : ' + esc(art.date) + '<br>' +
            'Localisation : ' + esc(art.location) + '<br>' +
            'Auteur : ' + esc(art.author) +
        '</div>' +
        banner +
        '<div class="hero-visual">' +
            imgTag(art.img, 'alt="Illustration" fetchpriority="high" decoding="async"') +
            '<div class="hero-title-overlay"><h2>' + esc(art.title) + '</h2></div>' +
            stampBig +
        '</div>' +
        '<div class="parody-banner" role="note"><strong>🎭 Article parodique</strong> — Faits, témoins et citations sont entièrement inventés. Certifié 100 % faux par la Rédaction.</div>' +
        '<div class="article-body">' +
            '<p>' + esc(art.intro) + '</p>' +
            interviewHTML +
            noticeHTML +
        '</div>' +
        voteHTML +
        shareHTML +
        '<div class="comments-zone" id="commentsZone"></div>';

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

    // Commentaires Cusdis (si configurés, hors brouillons)
    if (CUSDIS_APP_ID && !art._draft) {
        const zone = document.getElementById('commentsZone');
        zone.innerHTML = '<h3>💬 Témoignages des Éveillés</h3>' +
            '<div id="cusdis_thread" ' +
                'data-host="https://cusdis.com" ' +
                'data-app-id="' + esc(CUSDIS_APP_ID) + '" ' +
                'data-page-id="' + esc(art.id) + '" ' +
                'data-page-url="' + esc(articleURL(art.id)) + '" ' +
                'data-page-title="' + esc(art.title) + '"></div>';
        // (Re)charge le script Cusdis et force le rendu du fil courant
        if (window.CUSDIS && typeof window.CUSDIS.initial === 'function') {
            window.CUSDIS.initial();
        } else {
            const s = document.createElement('script');
            s.async = true;
            s.defer = true;
            s.src = 'https://cusdis.com/js/cusdis.es.js';
            document.body.appendChild(s);
        }
    }

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

    // Incrémente le choix en ligne
    const newVal = await hitCount(articleId, type);
    if (newVal !== null) {
        voteTotals[articleId][type] = newVal;
    } else {
        // En cas d'échec réseau, on incrémente localement pour le retour visuel
        voteTotals[articleId][type] = (voteTotals[articleId][type] || 0) + 1;
    }

    renderFeed();
    renderTop();
    refreshOpenArticleVotes();
}

// --- COMPTEUR DE VISITES (GoatCounter) ---

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
        window.goatcounter = { path: '/' }; // tout est compté sur la page d'accueil (site mono-page)
        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://gc.zgo.at/count.js';
        s.setAttribute('data-goatcounter', 'https://' + GOATCOUNTER_CODE + '.goatcounter.com/count');
        document.body.appendChild(s);
    }

    // Affichage du total (nécessite d'activer "visitor counts" dans les réglages GoatCounter)
    fetch('https://' + GOATCOUNTER_CODE + '.goatcounter.com/counter/' + encodeURIComponent('/') + '.json')
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

// --- IDENTIFICATION ---
// Seule l'empreinte SHA-256 de "identifiant:motdepasse" est stockée ici.
// Identifiants par défaut : admin / endam2026
// Pour changer : console du navigateur (F12) → genHash("nouvelId", "nouveauMdp")
// puis remplacez AUTH_HASH ci-dessous.
const AUTH_HASH = "99262f0f6b773271fbd4b0a23eeeb960f0a541f4d744ec740077cfac09948081";

let isAuthorized = false;

async function sha256(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

window.genHash = async function(user, pass) {
    const h = await sha256(user + ':' + pass);
    console.log('Nouveau AUTH_HASH à coller dans index.html :\n' + h);
    return h;
};

async function toggleStudio() {
    const panel = document.getElementById('adminPanel');

    if (isAuthorized) {
        const visible = panel.style.display === 'block';
        panel.style.display = visible ? 'none' : 'block';
        if (!visible) openStudioSession(panel);
        return;
    }

    const username = prompt("Saisir l'Identifiant d'accès au serveur :");
    if (username === null) return;
    const password = prompt("Saisir la Clé d'authentification (Mot de passe) :");
    if (password === null) return;

    let hash;
    try {
        hash = await sha256(username.trim() + ':' + password);
    } catch (err) {
        alert("ERREUR : le module de chiffrement nécessite une connexion sécurisée (https ou localhost).");
        return;
    }

    if (hash === AUTH_HASH) {
        isAuthorized = true;
        alert("Authentification réussie. Canal de transmission crypté ouvert. 📡");
        panel.style.display = 'block';
        openStudioSession(panel);
    } else {
        alert("ERREUR : Accès refusé. Les coordonnées ne correspondent pas aux archives secrètes.");
    }
}

function openStudioSession(panel) {
    if (workingArticles === null) {
        workingArticles = JSON.parse(JSON.stringify(articles));
    }
    if (!document.getElementById('formDate').value) {
        document.getElementById('formDate').value = todayFR();
    }
    renderManageList();
    const y = panel.getBoundingClientRect().top + window.pageYOffset - 20;
    window.scrollTo(0, y);
}

// --- GESTION DES ENQUÊTES (copie de travail) ---

function renderManageList() {
    const listDiv = document.getElementById('manageList');
    listDiv.innerHTML = "";

    if (!workingArticles || workingArticles.length === 0) {
        listDiv.innerHTML = '<div class="manage-row"><span class="row-title">Aucune enquête dans la copie de travail.</span></div>';
        return;
    }

    workingArticles.forEach((art, index) => {
        const row = document.createElement('div');
        row.className = 'manage-row' + (art._modified ? ' modified' : '');

        const badge = index === 0 ? '<span class="row-badge">BREAKING</span>' : '';
        const modifiedTag = art._modified ? ' (modifié ✏️)' : '';

        row.innerHTML =
            badge +
            '<span class="row-title" title="' + esc(art.title) + '">' + esc(truncateTitle(art.title, 70)) + modifiedTag + '</span>' +
            '<button type="button" class="mini-btn" data-action="edit">✏️ Modifier</button>' +
            '<button type="button" class="mini-btn danger" data-action="delete">🗑 Supprimer</button>';

        row.querySelector('[data-action="edit"]').addEventListener('click', () => editArticle(art.id));
        row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteArticle(art.id));

        listDiv.appendChild(row);
    });
}

function interviewToText(interview) {
    if (!interview || interview.length === 0) return '';
    return interview.map(r => 'Q: ' + r.q + '\nR: ' + r.a).join('\n');
}

function editArticle(id) {
    const art = workingArticles.find(a => a.id === id);
    if (!art) return;

    editingId = id;
    document.getElementById('formTitle').value = art.title || '';
    document.getElementById('formDate').value = art.date || '';
    document.getElementById('formLoc').value = art.location || '';
    document.getElementById('formAuthor').value = art.author || "L'Investigateur Anonyme";
    document.getElementById('formDesc').value = art.desc || '';
    document.getElementById('formIntro').value = art.intro || '';
    document.getElementById('formInterview').value = interviewToText(art.interview);
    document.getElementById('formNotice').value = art.notice || '';
    document.getElementById('formImg').value = (art.img || '').replace(/^images\//, '').replace(/^logo_chat_loupe\.png$/, '');
    document.getElementById('formClassified').value = art.classified ? 'oui' : 'non';

    document.getElementById('formHeading').textContent = '✏️ Modification de l\'enquête';
    document.getElementById('validateBtn').textContent = '✅ Enregistrer la modification';
    const notice = document.getElementById('editingNotice');
    notice.style.display = 'block';
    notice.textContent = 'Modification en cours : « ' + truncateTitle(art.title, 60) + ' »';
    document.getElementById('cancelEditBtn').style.display = 'inline-block';

    // Positionne la vue sur le titre du formulaire (sans 'smooth' qui bugue sur Safari,
    // et sans bloquer le défilement vers le bas du formulaire)
    const heading = document.getElementById('formHeading');
    if (heading) {
        const y = heading.getBoundingClientRect().top + window.pageYOffset - 20;
        window.scrollTo(0, y);
    }
}

function cancelEdit() {
    editingId = null;
    document.getElementById('studioForm').reset();
    document.getElementById('formAuthor').value = "L'Investigateur Anonyme";
    document.getElementById('formClassified').value = 'non';
    document.getElementById('formDate').value = todayFR();
    document.getElementById('formHeading').textContent = '✍️ Nouvelle enquête';
    document.getElementById('validateBtn').textContent = '✅ Ajouter à la copie de travail';
    document.getElementById('editingNotice').style.display = 'none';
    document.getElementById('cancelEditBtn').style.display = 'none';
}

function deleteArticle(id) {
    const art = workingArticles.find(a => a.id === id);
    if (!art) return;
    if (!confirm('Supprimer définitivement cette enquête de la copie de travail ?\n\n« ' + truncateTitle(art.title, 80) + ' »')) return;

    workingArticles = workingArticles.filter(a => a.id !== id);
    if (editingId === id) cancelEdit();
    renderManageList();
    refreshJSONIfVisible();
}

// --- CONSTRUCTION / VALIDATION D'UNE ENQUÊTE ---

function buildArticleFromForm(keepId, keepPublished) {
    const title = document.getElementById('formTitle').value.trim();
    const date = document.getElementById('formDate').value.trim() || todayFR();
    const location = document.getElementById('formLoc').value.trim() || "National";
    const author = document.getElementById('formAuthor').value.trim() || "L'Investigateur Anonyme";
    const desc = document.getElementById('formDesc').value.trim();
    const intro = document.getElementById('formIntro').value.trim();
    const notice = document.getElementById('formNotice').value.trim();
    const classified = /^o/i.test(document.getElementById('formClassified').value.trim());
    let img = document.getElementById('formImg').value.trim();
    if (img && !img.includes('/')) img = 'images/' + img;

    const interview = [];
    const raw = document.getElementById('formInterview').value;
    let current = null;
    raw.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (/^Q\s*:/i.test(trimmed)) {
            if (current && current.q) interview.push(current);
            current = { q: trimmed.replace(/^Q\s*:\s*/i, ''), a: '' };
        } else if (/^R\s*:/i.test(trimmed)) {
            if (current) current.a = trimmed.replace(/^R\s*:\s*/i, '');
        } else if (trimmed && current) {
            current.a = current.a ? current.a + ' ' + trimmed : trimmed;
        }
    });
    if (current && current.q) interview.push(current);

    return {
        id: keepId || ("art-" + Date.now()),
        title, date, location, author,
        img: img || "logo_chat_loupe.png",
        desc, intro, interview, notice, classified,
        // Date ISO pour le tri automatique et le flux RSS
        published: keepPublished || new Date().toISOString().slice(0, 10)
    };
}

function validateArticle(e) {
    e.preventDefault();

    if (editingId) {
        const index = workingArticles.findIndex(a => a.id === editingId);
        if (index !== -1) {
            const old = workingArticles[index];
            const updated = buildArticleFromForm(editingId, old.published);
            updated._modified = true;
            workingArticles[index] = updated;
        }
        cancelEdit();
        alert('Enquête mise à jour dans la copie de travail. ✏️\nPensez à générer et committer articles.json pour publier.');
    } else {
        const art = buildArticleFromForm();
        workingArticles.unshift(art);
        document.getElementById('studioForm').reset();
        document.getElementById('formAuthor').value = "L'Investigateur Anonyme";
        document.getElementById('formClassified').value = 'non';
        document.getElementById('formDate').value = todayFR();
        alert('Enquête ajoutée en tête de la copie de travail. 📰\nPensez à générer et committer articles.json pour publier.');
    }

    renderManageList();
    refreshJSONIfVisible();
}

function previewArticle() {
    const form = document.getElementById('studioForm');
    if (!form.reportValidity()) return;

    const art = buildArticleFromForm();
    art._draft = true;
    art.id = "draft-" + Date.now();

    draftArticles = [art];
    displayArticle(art.id, false);
}

// --- GÉNÉRATION DU FICHIER COMPLET ---

function cleanForExport(list) {
    return list.map(a => {
        const copy = { ...a };
        delete copy._modified;
        delete copy._draft;
        return copy;
    });
}

function generateFullJSON() {
    if (!workingArticles) return;
    const zone = document.getElementById('jsonZone');
    const output = document.getElementById('jsonOutput');
    output.value = JSON.stringify(cleanForExport(workingArticles), null, 2);
    zone.style.display = 'block';
    output.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function refreshJSONIfVisible() {
    const zone = document.getElementById('jsonZone');
    if (zone.style.display === 'block') {
        document.getElementById('jsonOutput').value = JSON.stringify(cleanForExport(workingArticles), null, 2);
    }
}

function copyJSON() {
    const output = document.getElementById('jsonOutput');
    output.select();
    navigator.clipboard.writeText(output.value)
        .then(() => alert("Fichier copié ! Direction GitHub → articles.json → remplacer tout le contenu. 📡"))
        .catch(() => {
            document.execCommand('copy');
            alert("Fichier copié (méthode de secours).");
        });
}

// --- INIT ---

document.addEventListener("DOMContentLoaded", () => {
    loadArticles();
    initVisitCounter();

    // Lien "Partager sur X" du pied de page → partage le site
    const sx = document.getElementById('socialX');
    if (sx) {
        const siteUrl = window.location.origin + '/';
        sx.href = 'https://twitter.com/intent/tweet?text=' +
            encodeURIComponent('Le Blog des Vérités Cachées — La voix de ceux qui savent') +
            '&url=' + encodeURIComponent(siteUrl);
    }
});
