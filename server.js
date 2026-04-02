const express   = require('express');
const fetch     = require('node-fetch');
const { getDetails } = require('spotify-url-info')(fetch);
const yts       = require('yt-search');
const cors      = require('cors');
const path      = require('path');
const os        = require('os');
const archiver  = require('archiver');
const initSqlJs = require('sql.js');
const multer    = require('multer');
const unzipper  = require('unzipper');
const fs        = require('fs');
const fsp       = require('fs').promises;

const app    = express();
const upload = multer({ dest: os.tmpdir() });

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isSpotifyPlaylist(url) {
  return /open\.spotify\.com\/(intl-[a-z]+\/)?playlist\/[a-zA-Z0-9]+/.test(url);
}

// ─── Spotify Track Fetching ───────────────────────────────────────────────────

const { getTracks: getTracksLib } = require('spotify-url-info')(fetch);

function extractPlaylistId(url) {
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function normalizeTracks(rawTracks) {
  return (rawTracks || [])
    .map(t => ({
      name:     t.name || t.title || '',
      artist:   t.artists ? t.artists.map(a => typeof a === 'string' ? a : a.name).join(', ') : (t.artist || ''),
      duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : (t.duration || -1),
    }))
    .filter(t => t.name);
}

async function tryGetSpotifyToken() {
  const urls = [
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    'https://open.spotify.com/get_access_token?reason=transport&productType=embedded_player',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer':         'https://open.spotify.com/',
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.accessToken) return data.accessToken;
      }
    } catch (_) {}
  }
  return null;
}

async function fetchViaApi(playlistUrl, token) {
  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) throw new Error('ID playlist non valido');

  const tracks = [];
  let offset = 0;
  let playlistName = 'Playlist';

  try {
    const r = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (r.ok) { const d = await r.json(); if (d.name) playlistName = d.name; }
  } catch (_) {}

  while (true) {
    const res = await fetch(
      `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&offset=${offset}&fields=next,items(track(name,artists(name),duration_ms))`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`API Spotify errore ${res.status}`);
    const data = await res.json();
    for (const item of (data.items || [])) {
      const t = item.track;
      if (t?.name) tracks.push({
        name:     t.name,
        artist:   t.artists ? t.artists.map(a => a.name).join(', ') : '',
        duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : -1,
      });
    }
    if (!data.next || (data.items?.length || 0) < 100) break;
    offset += 100;
    await sleep(150);
  }

  if (tracks.length === 0) throw new Error('Nessuna traccia trovata via API');
  return { tracks, playlistName };
}

async function getPlaylistNameFallback(playlistUrl) {
  // Metodo 1: spotify-url-info getDetails
  try {
    const details = await getDetails(playlistUrl);
    const name = details?.title || details?.name;
    if (name && name !== 'Spotify' && name.length > 0) return name;
  } catch (_) {}

  // Metodo 2: scraping pagina embed Spotify
  try {
    const playlistId = extractPlaylistId(playlistUrl);
    const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' }
    });
    if (res.ok) {
      const html = await res.text();
      const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/i)
                   || html.match(/name="title"\s+content="([^"]+)"/i);
      if (ogMatch) {
        const raw = ogMatch[1].replace(/ - playlist by.*$/i, '').replace(/ \| Spotify$/i, '').trim();
        if (raw && raw !== 'Spotify' && raw.length > 0) return raw;
      }
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) {
        const raw = titleMatch[1].replace(/ - playlist by.*$/i, '').replace(/ \| Spotify$/i, '').trim();
        if (raw && raw !== 'Spotify' && raw.length > 0) return raw;
      }
    }
  } catch (_) {}

  return null;
}

async function fetchViaEmbed(playlistUrl) {
  const rawTracks = await getTracksLib(playlistUrl);
  const tracks = normalizeTracks(rawTracks);
  if (tracks.length === 0) throw new Error('Nessuna traccia trovata');
  const playlistName = await getPlaylistNameFallback(playlistUrl) || 'Playlist';
  return { tracks, playlistName };
}

async function getAllTracks(playlistUrl) {
  const token = await tryGetSpotifyToken();
  if (token) {
    try { return await fetchViaApi(playlistUrl, token); }
    catch (e) { console.log('API fallita, fallback embed:', e.message); }
  }
  return await fetchViaEmbed(playlistUrl);
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

const AUDIO_KEYWORDS  = ['official audio', 'lyrics', 'lyric video', 'audio', 'visualizer'];
const VIDEO_BLACKLIST = ['live', 'concert', 'performance', 'cover', 'karaoke',
                         'reaction', 'tour', 'interview', 'making of'];

function scoreVideo(video, trackName, trackArtist, spotifyDuration) {
  const title = video.title.toLowerCase();
  let score = 0;

  for (const kw of AUDIO_KEYWORDS)  { if (title.includes(kw)) score += 15; }
  for (const kw of VIDEO_BLACKLIST) { if (title.includes(kw)) score -= 20; }

  if (title.includes(trackName.toLowerCase())) score += 10;
  if (trackArtist && title.includes(trackArtist.split(',')[0].toLowerCase())) score += 5;

  const uploader = (video.author?.name || '').toLowerCase();
  if (uploader.includes('vevo'))     score += 10;
  if (uploader.includes('official')) score += 5;

  // ── Filtro durata ─────────────────────────────────────────────────────────
  // Se abbiamo la durata Spotify, usiamo una finestra di tolleranza
  if (spotifyDuration > 0 && video.seconds > 0) {
    const diff = Math.abs(video.seconds - spotifyDuration);
    const tolerance = Math.max(15, spotifyDuration * 0.15); // ±15s o ±15%
    if (diff <= tolerance)       score += 20; // durata ottima
    else if (diff <= tolerance * 2) score += 5;  // un po' fuori
    else if (diff > 60)          score -= 25; // troppo diversa (quasi sicuramente versione sbagliata)
  } else {
    // Senza durata Spotify, penalizza solo estremi
    if (video.seconds > 0) {
      if (video.seconds < 90)  score -= 15;
      if (video.seconds > 600) score -= 10;
    }
  }

  return score;
}

// ── Stato quota YouTube API ───────────────────────────────────────────────────
let youtubeApiKey        = null;   // impostata dal frontend
let youtubeApiExhausted  = false;  // true quando quota esaurita oggi

// Converte durata ISO 8601 (PT3M45S) in secondi
function parseIsoDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
}

// Normalizza un titolo per confronto (minuscolo, rimuove punteggiatura)
function normalizeTitle(s) {
  return s.toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')  // rimuove parentesi
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Score per risultati YouTube Data API (più dati disponibili)
function scoreApiVideo(item, track) {
  const snippet  = item.snippet || {};
  const title    = (snippet.title || '').toLowerCase();
  const channel  = (snippet.channelTitle || '').toLowerCase();
  const duration = parseIsoDuration(item.contentDetails?.duration || '');
  let score = 0;

  // Keywords audio/lyrics
  for (const kw of ['official audio','audio','lyrics','lyric video','visualizer']) {
    if (title.includes(kw)) score += 15;
  }
  for (const kw of ['live','concert','cover','karaoke','reaction','making of']) {
    if (title.includes(kw)) score -= 20;
  }

  // Canale verificato o ufficiale
  if (snippet.channelTitle?.includes('VEVO'))    score += 15;
  if (channel.includes('official'))              score += 8;
  const firstArtist = (track.artist||'').split(',')[0].toLowerCase().trim();
  if (firstArtist && channel.includes(firstArtist)) score += 12;

  // Similarità titolo
  const normTitle  = normalizeTitle(snippet.title || '');
  const normTrack  = normalizeTitle(track.name);
  if (normTitle.includes(normTrack))  score += 15;
  if (firstArtist && normTitle.includes(firstArtist)) score += 8;

  // Penalizza remix non richiesti
  const trackHasRemix = /remix/i.test(track.name);
  const videoHasRemix = /remix/i.test(snippet.title || '');
  if (!trackHasRemix && videoHasRemix) score -= 20;

  // Filtro durata
  if (track.duration > 0 && duration > 0) {
    const diff = Math.abs(duration - track.duration);
    const tol  = Math.max(15, track.duration * 0.15);
    if (diff <= tol)       score += 20;
    else if (diff <= tol*2) score += 5;
    else if (diff > 60)    score -= 25;
  }

  return score;
}

// Ricerca via YouTube Data API ufficiale
async function searchYouTubeApi(track) {
  if (!youtubeApiKey || youtubeApiExhausted) return null;

  const firstArtist = track.artist ? track.artist.split(',')[0].trim() : '';
  const query = encodeURIComponent(
    track.artist ? `${track.name} ${firstArtist} official audio` : `${track.name} official audio`
  );

  try {
    // Step 1: search (100 quota units)
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=video&maxResults=10&videoCategoryId=10&key=${youtubeApiKey}`;
    const searchRes = await fetch(searchUrl);

    if (searchRes.status === 403) {
      const err = await searchRes.json();
      const reason = err?.error?.errors?.[0]?.reason || '';
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        console.log('⚠ Quota YouTube API esaurita, passo a yt-search');
        youtubeApiExhausted = true;
        return null;
      }
      throw new Error('YouTube API 403: ' + reason);
    }
    if (!searchRes.ok) throw new Error('YouTube API errore ' + searchRes.status);

    const searchData = await searchRes.json();
    const items = searchData.items || [];
    if (!items.length) return null;

    // Step 2: video details per durata (1 quota unit per video)
    const ids = items.map(i => i.id?.videoId).filter(Boolean).join(',');
    const detailUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids}&key=${youtubeApiKey}`;
    const detailRes = await fetch(detailUrl);
    const detailData = detailRes.ok ? await detailRes.json() : { items: [] };

    // Combina i dati
    const enriched = (detailData.items || []).map(item => ({
      ...item,
      snippet: item.snippet || items.find(i => i.id?.videoId === item.id)?.snippet || {},
    }));

    // Scegli il migliore
    let best = null, bestScore = -Infinity;
    for (const item of enriched) {
      const sc = scoreApiVideo(item, track);
      if (sc > bestScore) { bestScore = sc; best = item; }
    }

    if (!best) return null;
    const videoId = best.id;
    return {
      url:       `https://www.youtube.com/watch?v=${videoId}`,
      title:     best.snippet.title || '',
      uploader:      best.snippet.channelTitle || track.artist || '',
      spotifyTitle:  track.name,
      spotifyArtist: track.artist || '',
      duration:  parseIsoDuration(best.contentDetails?.duration || '') || track.duration || -1,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      source:    'api',
    };
  } catch (e) {
    console.error('YouTube API errore:', e.message);
    return null;
  }
}

// Ricerca via yt-search (scraping, fallback)
async function searchYouTubeScrape(track) {
  const firstArtist = track.artist ? track.artist.split(',')[0].trim() : '';
  const queries = [
    track.artist ? `${track.name} ${firstArtist} official audio` : `${track.name} official audio`,
    track.artist ? `${track.name} ${firstArtist} lyrics` : `${track.name} lyrics`,
    track.artist ? `${track.name} ${firstArtist}` : track.name,
    track.name,
  ].filter(Boolean);

  const MAX_RETRIES = 3;
  let bestResult = null, bestScore = -Infinity;

  for (const query of queries) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await yts(query);
        if (result.videos?.length) {
          for (const v of result.videos.slice(0, 5)) {
            const sc = scoreVideo(v, track.name, track.artist, track.duration);
            if (sc > bestScore) { bestScore = sc; bestResult = v; }
          }
        }
        break;
      } catch (e) {
        const isRL = e.message.includes('429') || e.message.includes('Too Many') || e.message.includes('socket');
        if (isRL && attempt < MAX_RETRIES - 1) {
          await sleep(2000 * (attempt + 1));
        } else { console.error(`yt-search errore "${query}":`, e.message); break; }
      }
    }
    if (bestScore >= 20) break;
    await sleep(400);
  }

  if (!bestResult) return null;
  return {
    url:       bestResult.url,
    title:     bestResult.title,
    uploader:      bestResult.author?.name || track.artist || '',
    spotifyTitle:  track.name,
    spotifyArtist: track.artist || '',
    duration:  bestResult.seconds || track.duration || -1,
    thumbnail: `https://i.ytimg.com/vi/${bestResult.videoId}/mqdefault.jpg`,
    source:    'scrape',
  };
}

// Funzione principale: prova API, fallback automatico a scraping
async function searchYouTube(track) {
  // Prova YouTube Data API se disponibile e quota non esaurita
  if (youtubeApiKey && !youtubeApiExhausted) {
    const result = await searchYouTubeApi(track);
    if (result) return result;
    // Se API ha fallito per motivi non-quota, non bloccare: vai al fallback
  }
  // Fallback: yt-search scraping
  return await searchYouTubeScrape(track);
}

// ─── Estrai DB da ZIP NewPipe ─────────────────────────────────────────────────

async function extractDbFromZip(zipPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', entry => {
        if (entry.path === 'newpipe.db') {
          entry.on('data', chunk => chunks.push(chunk));
          entry.on('end',  ()    => resolve(Buffer.concat(chunks)));
        } else { entry.autodrain(); }
      })
      .on('finish', () => { if (chunks.length === 0) reject(new Error('newpipe.db non trovato nello ZIP')); })
      .on('error', reject);
  });
}

// ─── Crea ZIP NewPipe ─────────────────────────────────────────────────────────

async function buildNewPipeZip(playlists, existingDbBuffer = null) {
  // playlists = [{ name, streams[] }]
  const SQL = await initSqlJs();
  let db;

  if (existingDbBuffer) {
    db = new SQL.Database(existingDbBuffer);
    const tables = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
    const names  = tables.length ? tables[0].values.map(r => r[0]) : [];
    if (!names.includes('playlists')) throw new Error('Il file ZIP non sembra un database NewPipe valido.');
  } else {
    db = new SQL.Database();
    db.run(`CREATE TABLE IF NOT EXISTS streams (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,service_id INTEGER NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,stream_type TEXT NOT NULL,duration INTEGER,uploader TEXT,uploader_url TEXT,thumbnail_url TEXT,view_count INTEGER,textual_upload_date TEXT,upload_date INTEGER,is_upload_date_approximation INTEGER,UNIQUE(service_id,url));`);
    db.run(`CREATE TABLE IF NOT EXISTS stream_history (stream_id INTEGER NOT NULL,access_date INTEGER NOT NULL,repeat_count INTEGER NOT NULL,PRIMARY KEY(stream_id,access_date),FOREIGN KEY(stream_id) REFERENCES streams(uid) ON UPDATE CASCADE ON DELETE CASCADE);`);
    db.run(`CREATE TABLE IF NOT EXISTS stream_state (stream_id INTEGER NOT NULL,progress_millis INTEGER NOT NULL,PRIMARY KEY(stream_id),FOREIGN KEY(stream_id) REFERENCES streams(uid) ON UPDATE CASCADE ON DELETE CASCADE);`);
    db.run(`CREATE TABLE IF NOT EXISTS search_history (creation_date INTEGER,search_string TEXT NOT NULL,id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL);`);
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,service_id INTEGER NOT NULL,url TEXT,name TEXT,avatar_url TEXT,subscriber_count INTEGER,description TEXT,notification_mode INTEGER NOT NULL DEFAULT 0,UNIQUE(service_id,url));`);
    db.run(`CREATE TABLE IF NOT EXISTS feed (stream_id INTEGER NOT NULL,subscription_id INTEGER NOT NULL,PRIMARY KEY(stream_id,subscription_id));`);
    db.run(`CREATE TABLE IF NOT EXISTS feed_last_updated (subscription_id INTEGER NOT NULL,last_updated INTEGER,PRIMARY KEY(subscription_id));`);
    db.run(`CREATE TABLE IF NOT EXISTS feed_group (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,name TEXT NOT NULL,icon_id INTEGER NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0);`);
    db.run(`CREATE TABLE IF NOT EXISTS feed_group_subscription_join (feed_group_id INTEGER NOT NULL,subscription_id INTEGER NOT NULL,PRIMARY KEY(feed_group_id,subscription_id));`);
    db.run(`CREATE TABLE IF NOT EXISTS remote_playlists (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,service_id INTEGER NOT NULL,name TEXT,url TEXT,thumbnail_url TEXT,uploader TEXT,stream_count INTEGER,UNIQUE(service_id,url));`);
    db.run(`CREATE TABLE IF NOT EXISTS playlists (uid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,name TEXT NOT NULL,thumbnail_url TEXT,display_index INTEGER NOT NULL DEFAULT 0,is_thumbnail_permanent INTEGER NOT NULL DEFAULT 0);`);
    db.run(`CREATE TABLE IF NOT EXISTS playlist_stream_join (playlist_id INTEGER NOT NULL,stream_id INTEGER NOT NULL,join_index INTEGER NOT NULL,PRIMARY KEY(playlist_id,join_index),FOREIGN KEY(playlist_id) REFERENCES playlists(uid) ON UPDATE CASCADE ON DELETE CASCADE,FOREIGN KEY(stream_id) REFERENCES streams(uid) ON UPDATE CASCADE ON DELETE CASCADE,UNIQUE(playlist_id,stream_id,join_index));`);
    db.run(`PRAGMA user_version = 9;`);
  }

  // Leggi schema reale
  function getColumns(tableName) {
    try {
      const res = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [tableName]);
      if (!res.length || !res[0].values.length) return [];
      const sql  = res[0].values[0][0] || '';
      const body = sql.replace(/^[^(]+\(/, '').replace(/\)[^)]*$/, '');
      return body.split(',').map(line => {
        const trimmed = line.trim();
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK)/i.test(trimmed)) return null;
        return trimmed.split(/\s+/)[0].replace(/["`[\]]/g, '');
      }).filter(Boolean);
    } catch { return []; }
  }

  // Leggi sempre le colonne reali dal DB (sia nuovo che esistente)
  const playlistCols = getColumns('playlists');
  const streamCols   = getColumns('streams');

  const hasThumbnailUrl      = playlistCols.includes('thumbnail_url');
  const hasThumbnailStreamId = playlistCols.includes('thumbnail_stream_id');
  const hasDisplayIndex      = playlistCols.includes('display_index');
  const hasIsThumbnailPerm   = playlistCols.includes('is_thumbnail_permanent');
  const hasThumbnailStream   = streamCols.includes('thumbnail_url');
  const hasViewCount         = streamCols.includes('view_count');

  // Inserisci ogni playlist
  for (const { name: playlistName, streams } of playlists) {
    // Inserisci stream
    const streamIds = [];
    for (const s of streams) {
      // Usa titolo Spotify come titolo stream, artista Spotify come fallback uploader
      const streamTitle    = s.spotifyTitle  || s.title;
      const streamUploader = s.uploader      || s.spotifyArtist || '';
      const sCols = ['service_id','url','title','stream_type','duration','uploader','uploader_url'];
      const sVals = [0, s.url, streamTitle, 'VIDEO_STREAM', s.duration, streamUploader, null];
      if (hasThumbnailStream) { sCols.push('thumbnail_url'); sVals.push(s.thumbnail); }
      if (hasViewCount)       { sCols.push('view_count');    sVals.push(-1); }
      db.run(`INSERT OR IGNORE INTO streams (${sCols.join(',')}) VALUES (${sCols.map(()=>'?').join(',')})`, sVals);
      const rows = db.exec(`SELECT uid FROM streams WHERE url = ?`, [s.url]);
      streamIds.push(rows.length > 0 ? rows[0].values[0][0] : null);
    }

    const firstStreamId = streamIds.find(id => id !== null) ?? null;

    const pCols = ['name'];
    const pVals = [playlistName];
    if (hasThumbnailUrl)      { pCols.push('thumbnail_url');       pVals.push(streams[0]?.thumbnail || null); }
    if (hasThumbnailStreamId) { pCols.push('thumbnail_stream_id'); pVals.push(firstStreamId); }
    if (hasDisplayIndex)      { pCols.push('display_index');       pVals.push(0); }
    if (hasIsThumbnailPerm)   { pCols.push('is_thumbnail_permanent'); pVals.push(0); }
    db.run(`INSERT INTO playlists (${pCols.join(',')}) VALUES (${pCols.map(()=>'?').join(',')})`, pVals);

    const playlistId = db.exec(`SELECT last_insert_rowid()`)[0].values[0][0];

    for (let i = 0; i < streamIds.length; i++) {
      if (streamIds[i] !== null) {
        db.run(`INSERT OR IGNORE INTO playlist_stream_join (playlist_id,stream_id,join_index) VALUES (?,?,?)`,
          [playlistId, streamIds[i], i]);
      }
    }
  }

  const dbBytes = db.export();
  db.close();

  return new Promise((resolve, reject) => {
    const chunks  = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data',  c => chunks.push(c));
    archive.on('end',   () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.append(Buffer.from(dbBytes), { name: 'newpipe.db' });
    archive.finalize();
  });
}

// ─── YouTube API key ─────────────────────────────────────────────────────────

app.post('/api/set-yt-key', (req, res) => {
  const { key } = req.body;
  youtubeApiKey       = key || null;
  youtubeApiExhausted = false; // reset quota status quando si imposta una nuova key
  console.log(key ? `🔑 YouTube API key impostata` : '🔑 YouTube API key rimossa');
  res.json({ ok: true });
});

app.get('/api/yt-status', (req, res) => {
  res.json({
    hasKey:    !!youtubeApiKey,
    exhausted: youtubeApiExhausted,
  });
});

// ─── Upload DB ────────────────────────────────────────────────────────────────

app.post('/api/upload-db', upload.single('dbzip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto.' });
  try {
    await extractDbFromZip(req.file.path);
    res.json({ ok: true, tmpPath: req.file.path });
  } catch (e) {
    await fsp.unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

// ─── Aggiornamento playlist ──────────────────────────────────────────────────

// Legge i titoli delle canzoni già presenti in una playlist del DB
app.post('/api/get-playlist-tracks', upload.single('dbzip'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file.' });
  const { playlistName } = req.body;
  try {
    const dbBuf = await extractDbFromZip(req.file.path);
    const SQL   = await initSqlJs();
    const db    = new SQL.Database(dbBuf);

    // Trova la playlist per nome
    const plRows = db.exec(`SELECT uid FROM playlists WHERE name = ?`, [playlistName]);
    if (!plRows.length || !plRows[0].values.length) {
      db.close(); await fsp.unlink(req.file.path).catch(()=>{});
      return res.json({ tracks: [], found: false });
    }
    const plId = plRows[0].values[0][0];

    // Recupera i titoli degli stream in quella playlist
    const stRows = db.exec(
      `SELECT s.title FROM streams s
       JOIN playlist_stream_join j ON j.stream_id = s.uid
       WHERE j.playlist_id = ?`, [plId]
    );
    const tracks = stRows.length ? stRows[0].values.map(r => r[0]) : [];
    db.close();
    await fsp.unlink(req.file.path).catch(()=>{});
    res.json({ tracks, found: true });
  } catch (e) {
    await fsp.unlink(req.file.path).catch(()=>{});
    res.status(500).json({ error: e.message });
  }
});

// ─── Converti playlist ────────────────────────────────────────────────────────

app.post('/api/convert', async (req, res) => {
  const { playlistUrls, existingDbPath, retryList, speed } = req.body;
  // speed: 'fast'=300ms, 'normal'=600ms, 'safe'=1200ms
  const delay = speed === 'fast' ? 300 : speed === 'safe' ? 1200 : 600;

  // Supporta sia array (multi-playlist) che stringa singola
  const urls = Array.isArray(playlistUrls) ? playlistUrls : [playlistUrls].filter(Boolean);

  if (!urls.length) return res.status(400).json({ error: 'URL mancante.' });
  for (const u of urls) {
    if (!retryList && !isSpotifyPlaylist(u)) return res.status(400).json({ error: `Link non valido: ${u}` });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    let existingDbBuffer = null;
    if (existingDbPath) {
      send({ type: 'status', message: '📂 Leggo il tuo database NewPipe...' });
      try {
        existingDbBuffer = await extractDbFromZip(existingDbPath);
      } catch (e) {
        send({ type: 'error', message: 'File ZIP non valido: ' + e.message });
        return res.end();
      }
    }

    const allPlaylists = []; // [{name, streams, found, total, notFound}]

    // ── Modalità retry ────────────────────────────────────────────────────────
    if (retryList && Array.isArray(retryList) && retryList.length > 0) {
      const tracks = retryList.map(t => {
        const parts = t.split(' — ');
        return { name: parts[0] || t, artist: parts[1] || '', duration: -1 };
      });
      send({ type: 'status', message: `🔄 Riprovo ${tracks.length} canzoni...` });
      send({ type: 'start', total: tracks.length, name: 'Retry', playlistIndex: 0, totalPlaylists: 1 });

      const streams  = [];
      const notFound = [];
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        send({ type: 'searching', current: i+1, total: tracks.length, track: `${track.name}${track.artist?' — '+track.artist:''}` });
        const video = await searchYouTube(track);
        if (video) { streams.push(video); send({ type: 'found', title: video.title, source: video.source || 'scrape' }); }
        else { notFound.push(`${track.name} — ${track.artist}`); send({ type: 'notFound', track: `${track.name} — ${track.artist}` }); }
        if (i < tracks.length - 1) await sleep(delay);
      }
      allPlaylists.push({ name: 'Retry', streams, found: streams.length, total: tracks.length, notFound });

    } else {
      // ── Modalità normale (una o più playlist) ────────────────────────────────
      for (let pi = 0; pi < urls.length; pi++) {
        const url      = urls[pi].split('?')[0];
        const isLast   = pi === urls.length - 1;

        send({ type: 'status', message: `🔍 [${pi+1}/${urls.length}] Recupero tracce...` });

        let tracks = [], playlistName = 'Playlist';
        try {
          const result = await getAllTracks(url);
          tracks = result.tracks;
          playlistName = result.playlistName || 'Playlist';
        } catch (e) {
          send({ type: 'error', message: `Errore playlist ${pi+1}: ${e.message}` });
          continue;
        }

        if (!tracks.length) {
          send({ type: 'error', message: `Playlist ${pi+1}: nessuna traccia trovata (è pubblica?)` });
          continue;
        }

        send({ type: 'start', total: tracks.length, name: playlistName, playlistIndex: pi, totalPlaylists: urls.length });

        const streams  = [];
        const notFound = [];

        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          send({ type: 'searching', current: i+1, total: tracks.length, track: `${track.name}${track.artist?' — '+track.artist:''}`, playlistIndex: pi });
          const video = await searchYouTube(track);
          if (video) { streams.push(video); send({ type: 'found', title: video.title, playlistIndex: pi, source: video.source || 'scrape' }); }
          else { notFound.push(`${track.name} — ${track.artist}`); send({ type: 'notFound', track: `${track.name} — ${track.artist}`, playlistIndex: pi }); }
          if (i < tracks.length - 1) await sleep(delay);
        }

        allPlaylists.push({ name: playlistName, streams, found: streams.length, total: tracks.length, notFound });

        if (!isLast) {
          send({ type: 'playlistDone', playlistIndex: pi, name: playlistName, found: streams.length, total: tracks.length });
          await sleep(1000);
        }
      }
    }

    if (!allPlaylists.length) {
      send({ type: 'error', message: 'Nessuna playlist convertita.' });
      return res.end();
    }

    send({ type: 'status', message: '📦 Creo il database NewPipe...' });

    const zipBuffer = await buildNewPipeZip(allPlaylists, existingDbBuffer);
    const zipBase64 = zipBuffer.toString('base64');

    if (existingDbPath) await fsp.unlink(existingDbPath).catch(() => {});

    send({
      type:       'done',
      zipBase64,
      playlists:  allPlaylists.map(p => ({ name: p.name, found: p.found, total: p.total, notFound: p.notFound })),
      merged:     !!existingDbBuffer,
    });

  } catch (error) {
    console.error('Errore:', error.message);
    let msg = error.message;
    if (msg.includes('ENOTFOUND') || msg.includes('fetch')) msg = 'Impossibile raggiungere Spotify. Controlla la connessione.';
    else if (msg.includes('404')) msg = 'Playlist non trovata. È pubblica?';
    send({ type: 'error', message: msg });
  }

  res.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) localIp = alias.address;
    }
  }
  console.log('\n🎵 Spotify → NewPipe Converter');
  console.log('─'.repeat(40));
  console.log(`   PC:       http://localhost:${PORT}`);
  console.log(`   Telefono: http://${localIp}:${PORT}`);
  console.log('─'.repeat(40) + '\n');
});
