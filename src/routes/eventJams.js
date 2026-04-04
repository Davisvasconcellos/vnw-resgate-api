const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireRole, requireModule } = require('../middlewares/auth');
const jwt = require('jsonwebtoken');
const { Op, literal } = require('sequelize');
const { normalizeJamInstrumentSlotsPayload, normalizeJamInstrumentSlotsRows } = require('../utils/jamInstrumentSlots');
const { Event, EventJam, EventJamSong, EventJamSongInstrumentSlot, EventJamSongCandidate, EventJamSongRating, EventGuest, User, EventJamMusicCatalog, TokenBlocklist } = require('../models');
const discogsService = require('../services/discogsService');
const { incrementMetric } = require('../utils/requestContext');
const { jamsCache, clearJamsCache, JAMS_CACHE_TTL } = require('../utils/cacheManager');

const router = express.Router();

// Middleware opcional para extrair usuário se token existir
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token) {
    try {
      const isBlocked = await TokenBlocklist.findByPk(token);
      if (!isBlocked) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Define req.user se válido
      }
    } catch (err) {
      // Ignora erro, segue como guest (req.user undefined)
    }
  }
  next();
};

const sseClients = new Map();
const getKey = (eventId, jamId) => `${eventId}-${jamId}`;
const emitEvent = (eventId, jamId, type, payload) => {
  const key = getKey(eventId, jamId);
  const set = sseClients.get(key);
  if (!set) return;
  const data = JSON.stringify({ type, payload });
  for (const res of set) {
    res.write(`data: ${data}\n\n`);
  }
};

router.get('/:id/jams/:jamId/stream', (req, res) => {
  const { id, jamId } = req.params;
  req.headers['x-no-compression'] = 'true';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const key = getKey(id, jamId);
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  const set = sseClients.get(key);
  set.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 30000);
  req.on('close', () => {
    set.delete(res);
    clearInterval(heartbeat);
  });
});

// GET /:id/jam (Singular) - Retorna a Jam principal do evento (para guests)
router.get('/:id/jam', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });

    const jam = await EventJam.findOne({ 
      where: { event_id: event.id },
      order: [['order_index', 'ASC'], ['created_at', 'ASC']]
    });

    if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Nenhuma Jam ativa encontrada' });

    return res.json({
      success: true,
      data: {
        id: jam.id_code,
        name: jam.name,
        status: jam.status,
        slug: jam.slug
      }
    });
  } catch (err) {
    console.error('[EventJams] GET /jam Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /:id/jams/open - Retorna músicas abertas para candidatura
router.get('/:id/jams/open', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });

    const jams = await EventJam.findAll({
      where: { event_id: event.id },
      include: [{
        model: EventJamSong,
        as: 'songs',
        where: { status: 'open_for_candidates' },
        include: [
          { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
          { 
            model: EventJamSongCandidate, 
            as: 'candidates',
            include: [{ model: EventGuest, as: 'guest', include: [{ model: User, as: 'user' }] }] 
          }
        ]
      }]
    });

    // Identify current user guest if logged in
    let currentGuestId = null;
    
    // Manual token extraction fallback
    let authUser = req.user;
    if (!authUser) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                authUser = decoded;
            } catch (e) {
                console.error('[EventJams] Token manual decode failed:', e.message);
            }
        }
    }

    if (authUser && authUser.userId) {
       // DIRECT LOOKUP: Find Guest by user_id (int)
       // We trust the JWT userId (int) is correct.
       // We look for a guest in this event that is linked to this user_id.
       const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: authUser.userId } });
       
       if (guest) {
            currentGuestId = guest.id;
       } else {
            console.warn(`[EventJams] Guest not found for UserID ${authUser.userId} in EventID ${event.id}`);
       }
    } else {
       // Fallback for guest mode if guest_id is provided in query/header (optional)
       const guestIdCode = req.query.guest_id || req.headers['x-guest-id'];
       if (guestIdCode) {
           const guest = await EventGuest.findOne({ where: { event_id: event.id, id_code: guestIdCode } });
           if (guest) currentGuestId = guest.id;
       }
    }

    const songs = [];
    jams.forEach(jam => {
      jam.songs.forEach(s => {
        // Find if user has applied to any slot in this song
        let myApplication = null;
        if (currentGuestId) {
            // Find in candidates list. Important: Sequelize objects need .get() or plain check if raw.
            // s.candidates is an array of Sequelize instances.
            const app = s.candidates.find(c => {
                const cGuestId = c.event_guest_id || (c.get ? c.get('event_guest_id') : null);
                return String(cGuestId) === String(currentGuestId); // Ensure type consistency
            });
            
            if (app) {
                myApplication = {
                    id: app.id_code || (app.get ? app.get('id_code') : null),
                    instrument: app.instrument || (app.get ? app.get('instrument') : null),
                    status: app.status || (app.get ? app.get('status') : null)
                };
            }
        }

        songs.push({
          id: s.id_code,
          title: s.title,
          artist: s.artist,
          cover_image: s.cover_image,
          status: s.status,
          my_application: myApplication, // Add this field
          slots: s.instrumentSlots.map(slot => {
            const slotCandidates = s.candidates.filter(c => c.instrument === slot.instrument);
            
            const approvedCandidates = slotCandidates.filter(c => c.status === 'approved');
            const taken = approvedCandidates.length;
            
            return {
              id: slot.id, // Add slot ID if needed by frontend
              instrument: slot.instrument,
              total: slot.slots,
              taken: taken,
              remaining: Math.max(0, slot.slots - taken),
              required: slot.required,
              fallback_allowed: slot.fallback_allowed
            };
          })
        });
      });
    });

    return res.json({ success: true, data: songs });
  } catch (err) {
    console.error('[EventJams] GET /jams/open Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});



// Caches were moved to src/utils/cacheManager.js for cross-route invalidation

router.get('/:id/jams', authenticateToken, async (req, res) => {
try {
  const { id } = req.params;
  const onlyReal = String(req.query.only_real || 'false').toLowerCase() === 'true';
  const includeLyrics = String(req.query.include_lyrics || 'false').toLowerCase() === 'true';
  const cacheKey = `v2-${id}-${onlyReal}-${includeLyrics}`;
  
  // Check cache
  const cached = jamsCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < JAMS_CACHE_TTL)) {
    if (process.env.NODE_ENV === 'development') console.log(`[JamsCache] HIT! Key: ${cacheKey}`);
    const globalMetrics = req.app.get('metrics');
    if (globalMetrics) globalMetrics.cacheHits++;
    incrementMetric('cacheHits'); // HUD v2 visibility
    return res.json(cached.data);
  } else {
    if (process.env.NODE_ENV === 'development') console.log(`[JamsCache] MISS. Key: ${cacheKey}`);
  }

  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  
  const jams = await EventJam.findAll({
    where: { event_id: event.id },
    include: [{
      model: EventJamSong,
      as: 'songs',
      separate: true,
      order: [['order_index', 'ASC']],
      include: [
        { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
        {
          model: EventJamMusicCatalog,
          as: 'catalog',
          required: false,
          attributes: includeLyrics
            ? ['id_code', 'lyrics', [literal(`CASE WHEN "catalog"."lyrics" IS NULL OR "catalog"."lyrics" = '' THEN false ELSE true END`), 'has_lyrics']]
            : ['id_code', [literal(`CASE WHEN "catalog"."lyrics" IS NULL OR "catalog"."lyrics" = '' THEN false ELSE true END`), 'has_lyrics']]
        },
        { model: EventJamSongCandidate, as: 'candidates', include: [{ model: EventGuest, as: 'guest', include: [{ model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'email', 'avatar_url'] }] }] },
        { model: EventJamSongRating, as: 'ratings' }
      ]
    }]
  });
  
  const data = jams.map(j => {
    const songs = (j.songs || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0)).map(s => {
      const byInstrument = {};
      for (const slot of (s.instrumentSlots || [])) {
        byInstrument[slot.instrument] = { instrument: slot.instrument, slots: slot.slots, required: slot.required, fallback_allowed: slot.fallback_allowed, approved: [], pending: [] };
      }
      for (const c of (s.candidates || [])) {
        if (onlyReal && !(c.guest && c.guest.user)) continue;
        const bucket = byInstrument[c.instrument] || (byInstrument[c.instrument] = { instrument: c.instrument, slots: 0, required: false, fallback_allowed: true, approved: [], pending: [] });
        const displayName = c.guest?.user?.name || c.guest?.guest_name || null;
        const email = c.guest?.user?.email || c.guest?.guest_email || null;
        const avatar_url = c.guest?.selfie_url || c.guest?.user?.avatar_url || null;
        const entry = { candidate_id: c.id_code, guest_id: c.guest?.id_code, display_name: displayName, email, avatar_url, status: c.status };
        if (c.status === 'approved') bucket.approved.push(entry); else bucket.pending.push(entry);
      }
      const ratings = s.ratings || [];
      const avg = ratings.length ? (ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) : null;
      const hasLyricsRaw = s.catalog && (typeof s.catalog.get === 'function' ? s.catalog.get('has_lyrics') : s.catalog.has_lyrics);
      const lyrics_available = hasLyricsRaw === true || hasLyricsRaw === 'true';
      return {
        id: s.id_code,
        jam_id: j.id_code,
        title: s.title,
        artist: s.artist,
        cover_image: s.cover_image,
        catalog_id: s.catalog ? s.catalog.id_code : null,
        lyrics_available,
        ...(includeLyrics ? { lyrics: (s.catalog && s.catalog.lyrics) ? s.catalog.lyrics : null } : {}),
        status: s.status,
        ready: !!s.ready,
        order_index: s.order_index,
        release_batch: s.release_batch,
        instrument_buckets: Object.values(byInstrument),
        rating_summary: ratings.length ? { average: Number(avg.toFixed(2)), count: ratings.length } : null
      };
    });
    return { id: j.id_code, event_id: event.id_code, name: j.name, slug: j.slug, status: j.status, order_index: j.order_index, songs };
  });

  const responseData = { success: true, data };
  
  // Save to cache
  jamsCache.set(cacheKey, {
    data: responseData,
    timestamp: Date.now()
  });
  if (process.env.NODE_ENV === 'development') console.log(`[JamsCache] SAVED! Key: ${cacheKey}`);

  // Set Cache-Control header to no-store/private for admins to ensure real-time behavior in Kanban
  res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  
  return res.json(responseData);
} catch (err) {
  // Failover to Cache: se o banco falhar, tenta retornar o que temos na memória (mesmo que velho)
  const onlyReal = String(req.query.only_real || 'false').toLowerCase() === 'true';
  const includeLyrics = String(req.query.include_lyrics || 'false').toLowerCase() === 'true';
  const cacheKey = `v2-${req.params.id}-${onlyReal}-${includeLyrics}`;
  const stale = jamsCache.get(cacheKey);
  
  if (stale) {
    const globalMetrics = req.app.get('metrics');
    if (globalMetrics) globalMetrics.dbErrors++;
    incrementMetric('cacheHits'); // Acumula como hit se serviu failover
    console.warn(`[FAILOVER] Servindo cache antigo para /jams devido a erro: ${err.message}`);
    res.setHeader('X-Cache-Failover', 'true');
    return res.json(stale.data);
  }
  
  // Se não tiver nem no cache, aí sim retorna erro
  console.error(`[CRITICAL] Rota /jams falhou sem cache: ${err.message}`);
  return res.status(500).json({ error: 'Database Error', message: 'Erro ao carregar Jams' });
}
});

router.get('/:id/jams/songs', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id } = req.params;
  const includeLyrics = String(req.query.include_lyrics || 'false').toLowerCase() === 'true';
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  if (req.user.role !== 'master' && event.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
  const jams = await EventJam.findAll({ where: { event_id: event.id } });
  const jamIds = jams.map(j => j.id);
  const jamIdMap = jams.reduce((acc, j) => { acc[j.id] = j.id_code; return acc; }, {});

  const { status, search, release_batch, page = 1, page_size = 20, order = 'asc', sort_by = 'order_index' } = req.query;
  const onlyReal = String(req.query.only_real || 'false').toLowerCase() === 'true';
  const where = { jam_id: { [Op.in]: jamIds } };
  if (status && ['planned','open_for_candidates','on_stage','played','canceled'].includes(status)) where.status = status;
  if (release_batch !== undefined) where.release_batch = release_batch;
  if (search) where.title = { [Op.like]: `%${search}%` };

  const offset = (Math.max(parseInt(page), 1) - 1) * Math.max(parseInt(page_size), 1);
  const limit = Math.max(parseInt(page_size), 1);
  const sortField = ['order_index','title','status','created_at'].includes(sort_by) ? sort_by : 'order_index';
  const sortDir = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const total = await EventJamSong.count({ where });
  const songs = await EventJamSong.findAll({
    where,
    order: [[sortField, sortDir]],
    offset,
    limit,
    include: [
      { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
      {
        model: EventJamMusicCatalog,
        as: 'catalog',
        required: false,
        attributes: includeLyrics
          ? ['id_code', 'lyrics', [literal(`CASE WHEN "catalog"."lyrics" IS NULL OR "catalog"."lyrics" = '' THEN false ELSE true END`), 'has_lyrics']]
          : ['id_code', [literal(`CASE WHEN "catalog"."lyrics" IS NULL OR "catalog"."lyrics" = '' THEN false ELSE true END`), 'has_lyrics']]
      },
      { model: EventJamSongCandidate, as: 'candidates', include: [{ model: EventGuest, as: 'guest', include: [{ model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'email', 'avatar_url'] }] }] },
      { model: EventJamSongRating, as: 'ratings' }
    ]
  });

  const data = songs.map(s => {
    const byInstrument = {};
    for (const slot of (s.instrumentSlots || [])) {
      byInstrument[slot.instrument] = { instrument: slot.instrument, slots: slot.slots, required: slot.required, fallback_allowed: slot.fallback_allowed, approved: [], pending: [] };
    }
    for (const c of (s.candidates || [])) {
      if (onlyReal && !(c.guest && c.guest.user)) continue;
      const bucket = byInstrument[c.instrument] || (byInstrument[c.instrument] = { instrument: c.instrument, slots: 0, required: false, fallback_allowed: true, approved: [], pending: [] });
      const displayName = c.guest?.user?.name || c.guest?.guest_name || null;
      const email = c.guest?.user?.email || c.guest?.guest_email || null;
      const avatar_url = c.guest?.user?.avatar_url || null;
      const entry = { candidate_id: c.id_code, guest_id: c.guest?.id_code, display_name: displayName, email, avatar_url, status: c.status };
      if (c.status === 'approved') bucket.approved.push(entry); else bucket.pending.push(entry);
    }
    const ratings = s.ratings || [];
    const avg = ratings.length ? (ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) : null;
    const hasLyricsRaw = s.catalog && (typeof s.catalog.get === 'function' ? s.catalog.get('has_lyrics') : s.catalog.has_lyrics);
    const lyrics_available = hasLyricsRaw === true || hasLyricsRaw === 'true';
    return {
      id: s.id_code,
      jam_id: jamIdMap[s.jam_id],
      title: s.title,
      artist: s.artist,
      catalog_id: s.catalog ? s.catalog.id_code : null,
      lyrics_available,
      ...(includeLyrics ? { lyrics: (s.catalog && s.catalog.lyrics) ? s.catalog.lyrics : null } : {}),
      status: s.status,
      ready: !!s.ready,
      order_index: s.order_index,
      release_batch: s.release_batch,
      instrument_buckets: Object.values(byInstrument),
      rating_summary: ratings.length ? { average: Number(avg.toFixed(2)), count: ratings.length } : null
    };
  });

  return res.json({ success: true, data, meta: { page: parseInt(page), page_size: parseInt(page_size), total } });
});

router.get('/:id/jams/catalog/:catalogId', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  try {
    const { id, catalogId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied' });

    const item = await EventJamMusicCatalog.findOne({
      where: { id_code: catalogId },
      attributes: ['id_code', 'title', 'artist', 'cover_image', 'lyrics', 'chords', 'updated_at', 'created_at']
    });
    if (!item) return res.status(404).json({ error: 'Not Found', message: 'Catálogo não encontrado' });

    const j = item.toJSON();
    return res.json({ success: true, data: { catalog: { ...j, id: j.id_code } } });
  } catch (error) {
    console.error('Get catalog item error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.patch('/:id/jams/catalog/:catalogId', authenticateToken, requireRole('admin', 'master'), [
  body('lyrics').optional({ nullable: true }).isString(),
  body('chords').optional({ nullable: true }).isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    const { id, catalogId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied' });

    const item = await EventJamMusicCatalog.findOne({ where: { id_code: catalogId } });
    if (!item) return res.status(404).json({ error: 'Not Found', message: 'Catálogo não encontrado' });

    const payload = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'lyrics')) payload.lyrics = req.body.lyrics === null ? null : req.body.lyrics;
    if (Object.prototype.hasOwnProperty.call(req.body, 'chords')) payload.chords = req.body.chords === null ? null : req.body.chords;

    await item.update(payload);
    clearJamsCache(id);

    const j = item.toJSON();
    return res.json({
      success: true,
      data: {
        catalog: {
          id: j.id_code,
          id_code: j.id_code,
          title: j.title,
          artist: j.artist,
          cover_image: j.cover_image,
          lyrics: j.lyrics || null,
          chords: j.chords || null,
          updated_at: j.updated_at
        }
      }
    });
  } catch (error) {
    console.error('Update catalog item error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/jams', authenticateToken, requireRole('admin', 'master'), [
  body('name').isLength({ min: 2 }),
  body('slug').isLength({ min: 2 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
    const { name, slug, notes, status, order_index } = req.body;

    const exists = await EventJam.findOne({
      where: {
        [Op.or]: [
          { event_id: event.id, name },
          { slug }
        ]
      }
    });
    if (exists) {
      return res.status(409).json({ error: 'Duplicate entry', message: 'Jam já está cadastrada', details: [{ field: exists.slug === slug ? 'slug' : 'name', issue: 'duplicate' }] });
    }

    const jam = await EventJam.create({ event_id: event.id, name, slug, status: status || 'active', order_index: order_index || 0 });
    clearJamsCache(id);
    return res.status(201).json({ success: true, data: { id: jam.id_code, event_id: event.id_code, name: jam.name, slug: jam.slug, status: jam.status, order_index: jam.order_index } });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Duplicate entry', message: 'Jam já está cadastrada', details: [{ field: 'slug', issue: 'duplicate' }] });
    }
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/jams/:jamId/songs', authenticateToken, requireRole('admin', 'master'), [
  body('title').isLength({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const { title, artist, cover_image, extra_data, key, tempo_bpm, notes, release_batch, status, order_index, catalog_id } = req.body;
  const song = await EventJamSong.create({ jam_id: jam.id, title, artist: artist || null, cover_image: cover_image || null, extra_data: extra_data || null, key: key || null, tempo_bpm: tempo_bpm || null, notes: notes || null, release_batch: release_batch || null, status: status || 'planned', order_index: order_index || 0, catalog_id: catalog_id || null });
  
  if (catalog_id) {
    try {
      await EventJamMusicCatalog.increment('usage_count', { where: { id: catalog_id } });
    } catch (e) {
      console.error('Erro ao incrementar usage_count:', e);
    }
  }

  emitEvent(id, jam.id_code, 'song_created', { song_id: song.id_code });
  clearJamsCache(id);
  return res.status(201).json({ success: true, data: { ...song.toJSON(), id: song.id_code, jam_id: jam.id_code, id_code: undefined } });
});

router.post('/:id/jams/songs', authenticateToken, requireRole('admin', 'master'), [
  body('title').isLength({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) return res.status(403).json({ error: 'Access denied' });

    let jam = await EventJam.findOne({ where: { event_id: event.id } });
    if (!jam) {
      const defaultSlug = `jam-${event.slug}`;
      const defaultName = event.name;
      jam = await EventJam.create({ event_id: event.id, name: defaultName, slug: defaultSlug, status: 'active', order_index: 0 });
    }

    let { title, artist, cover_image, extra_data, key, tempo_bpm, notes, release_batch, status, order_index, instrument_slots, catalog_id, pre_approved_candidates } = req.body;
    
    // Auto-search Cover Image Logic
    if (!cover_image) {
      try {
        // 1. Check Local Catalog first (if not provided explicitly)
        if (!catalog_id) {
          const localMatch = await EventJamMusicCatalog.findOne({
            where: {
              title: { [Op.like]: title }, // Exact match
              artist: artist ? { [Op.like]: artist } : { [Op.ne]: null }
            }
          });
          
          if (localMatch) {
            console.log(`[EventJams] Found local cover for "${title}"`);
            cover_image = localMatch.cover_image;
            if (!catalog_id) catalog_id = localMatch.id;
          }
        } else {
          // If catalog_id is provided but no cover, fetch from catalog
          const catalogItem = await EventJamMusicCatalog.findByPk(catalog_id);
          if (catalogItem && catalogItem.cover_image) {
            cover_image = catalogItem.cover_image;
          }
        }

        // 2. Check Discogs if still no cover
        if (!cover_image) {
          const query = artist ? `${artist} - ${title}` : title;
          console.log(`[EventJams] Searching Discogs for "${query}"`);
          const results = await discogsService.search(query);
          
          if (results && results.length > 0) {
            const bestMatch = results[0];
            cover_image = bestMatch.cover_image;
            
            // Optional: Save to catalog for future use
            // Check if exists first to avoid duplicates
            const existing = await EventJamMusicCatalog.findOne({ where: { discogs_id: bestMatch.id } });
            if (!existing) {
              const newCatalogItem = await EventJamMusicCatalog.create({
                discogs_id: bestMatch.id,
                title: bestMatch.title,
                artist: bestMatch.artist,
                cover_image: bestMatch.cover_image,
                thumb_image: bestMatch.thumb,
                year: bestMatch.year,
                genre: bestMatch.genre,
                extra_data: bestMatch,
                usage_count: 1
              });
              if (!catalog_id) catalog_id = newCatalogItem.id;
            } else {
               if (!catalog_id) catalog_id = existing.id;
            }
          }
        }
      } catch (err) {
        console.error('[EventJams] Error fetching cover image:', err);
        // Continue without cover
      }
    }
    
        // Check if catalog_id is valid (Discogs ID vs Local ID)
    if (catalog_id) {
      try {
        let catalogItem = null;
        const parsedId = parseInt(catalog_id, 10);
        
        // 1. Try to find by PK (Local ID)
        if (!isNaN(parsedId)) {
             catalogItem = await EventJamMusicCatalog.findByPk(parsedId);
        }

        // 2. If not found by PK, try to find by Discogs ID
        if (!catalogItem && !isNaN(parsedId)) {
          catalogItem = await EventJamMusicCatalog.findOne({ where: { discogs_id: parsedId } });
        }

        if (catalogItem) {
          // Found! Update catalog_id to be the real Local PK
          catalog_id = catalogItem.id;
        } else {
            // 3. Not found locally at all. Create it.
            // We assume the ID passed was a Discogs ID since it wasn't a valid PK
            console.log(`[EventJams] Catalog ID ${catalog_id} not found locally. Creating new entry.`);
            
            // Validate required fields for creation
            if (title && artist) {
               catalogItem = await EventJamMusicCatalog.create({
                 discogs_id: !isNaN(parsedId) ? parsedId : null,
                 title: title,
                 artist: artist,
                 cover_image: cover_image,
                 usage_count: 0
               });
               catalog_id = catalogItem.id;
            } else {
               // Cannot create without title/artist, so ignore catalog_id
               console.warn('[EventJams] Cannot create catalog entry without title/artist. Ignoring catalog_id.');
               catalog_id = null;
            }
        }
      } catch (e) {
        console.error('[EventJams] Error validating catalog_id:', e);
        catalog_id = null;
      }
    }

    // Start a transaction for data integrity
    const tx = await EventJamSong.sequelize.transaction();
    
    try {
      const song = await EventJamSong.create({ jam_id: jam.id, title, artist: artist || null, cover_image: cover_image || null, extra_data: extra_data || null, key: key || null, tempo_bpm: tempo_bpm || null, notes: notes || null, release_batch: release_batch || null, status: status || 'planned', order_index: order_index || 0, catalog_id: catalog_id || null }, { transaction: tx });

      if (catalog_id) {
        try {
          // Check if catalog_id is numeric (local ID) before using
          // If it's a discogs ID (large number), we might need to find the local ID first
          // But here we assume catalog_id refers to EventJamMusicCatalog.id (PK)
          // Also, transaction is important!
          await EventJamMusicCatalog.increment('usage_count', { where: { id: catalog_id }, transaction: tx });
        } catch (e) {
          console.error('Erro ao incrementar usage_count:', e);
        }
      }

      const normalizedPayloadSlots = normalizeJamInstrumentSlotsPayload(instrument_slots);
      if (normalizedPayloadSlots.length) {
        for (const s of normalizedPayloadSlots) {
          await EventJamSongInstrumentSlot.create({ jam_song_id: song.id, instrument: s.instrument, slots: s.slots || 1, required: s.required !== undefined ? !!s.required : true, fallback_allowed: s.fallback_allowed !== undefined ? !!s.fallback_allowed : true }, { transaction: tx });
        }
      }

      if (Array.isArray(pre_approved_candidates) && pre_approved_candidates.length) {
         for (const candidate of pre_approved_candidates) {
           if (!candidate.user_id || !candidate.instrument) continue;
           
           const userIdClean = String(candidate.user_id).trim();
           // Frontend sends id_code (UUID) as user_id. Find the internal numeric ID first.
           const user = await User.findOne({ where: { id_code: userIdClean }, transaction: tx });
           if (!user) continue;

           const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: user.id }, transaction: tx });
           if (guest) {
              await EventJamSongCandidate.create({
                jam_song_id: song.id,
                instrument: candidate.instrument,
                event_guest_id: guest.id,
                status: 'approved',
                approved_at: new Date(),
                approved_by_user_id: req.user.userId
              }, { transaction: tx });
           }
         }
       }

      await tx.commit();
      clearJamsCache(id);

      if (Array.isArray(instrument_slots) && instrument_slots.length) {
        emitEvent(id, jam.id_code, 'instrument_slots_updated', { song_id: song.id_code });
      }
      
      emitEvent(id, jam.id_code, 'song_created', { song_id: song.id_code });

      // Reload song with full associations to return formatted data
      const reloadedSong = await EventJamSong.findOne({
        where: { id: song.id },
        include: [
          { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
          { model: EventJamSongCandidate, as: 'candidates', include: [{ model: EventGuest, as: 'guest', include: [{ model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'email', 'avatar_url'] }] }] },
          { model: EventJamSongRating, as: 'ratings' }
        ]
      });

      // Format the response to match GET structure
      const byInstrument = {};
      for (const slot of (reloadedSong.instrumentSlots || [])) {
        byInstrument[slot.instrument] = { instrument: slot.instrument, slots: slot.slots, required: slot.required, fallback_allowed: slot.fallback_allowed, approved: [], pending: [] };
      }
      for (const c of (reloadedSong.candidates || [])) {
        const bucket = byInstrument[c.instrument] || (byInstrument[c.instrument] = { instrument: c.instrument, slots: 0, required: false, fallback_allowed: true, approved: [], pending: [] });
        const displayName = c.guest?.user?.name || c.guest?.guest_name || null;
        const email = c.guest?.user?.email || c.guest?.guest_email || null;
        const avatar_url = c.guest?.user?.avatar_url || null;
        const entry = { candidate_id: c.id_code, guest_id: c.guest?.id_code, display_name: displayName, email, avatar_url, status: c.status };
        if (c.status === 'approved') bucket.approved.push(entry); else bucket.pending.push(entry);
      }
      const ratings = reloadedSong.ratings || [];
      const avg = ratings.length ? (ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) : null;
      
      const formattedSong = {
        id: reloadedSong.id_code,
        jam_id: jam.id_code,
        title: reloadedSong.title,
        artist: reloadedSong.artist,
        status: reloadedSong.status,
        ready: !!reloadedSong.ready,
        order_index: reloadedSong.order_index,
        release_batch: reloadedSong.release_batch,
        instrument_buckets: Object.values(byInstrument),
        rating_summary: ratings.length ? { average: Number(avg.toFixed(2)), count: ratings.length } : null,
        cover_image: reloadedSong.cover_image,
        extra_data: reloadedSong.extra_data,
        catalog_id: reloadedSong.catalog_id,
        updated_at: reloadedSong.updated_at,
        created_at: reloadedSong.created_at
      };

      return res.status(201).json({ success: true, data: { jam: { id: jam.id_code, event_id: event.id_code, name: jam.name, status: jam.status }, song: formattedSong } });
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  } catch (err) {
    console.error('[EventJams] Create Song Error:', err);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'Duplicate entry', message: 'Slug de jam ou configuração duplicada' });
    }
    return res.status(500).json({ error: 'Internal server error', message: err.message || 'Erro interno do servidor' });
  }
});

router.post('/:id/jams/:jamId/songs/:songId/instrument-slots', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id, jamId, songId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  const slots = Array.isArray(req.body) ? req.body : (req.body.instrument_slots || []);
  const tx = await EventJamSongInstrumentSlot.sequelize.transaction();
  try {
    await EventJamSongInstrumentSlot.destroy({ where: { jam_song_id: song.id }, transaction: tx });
    const normalized = normalizeJamInstrumentSlotsPayload(slots);
    for (const s of normalized) {
      await EventJamSongInstrumentSlot.create({ jam_song_id: song.id, instrument: s.instrument, slots: s.slots || 1, required: s.required !== undefined ? !!s.required : true, fallback_allowed: s.fallback_allowed !== undefined ? !!s.fallback_allowed : true }, { transaction: tx });
    }
    await tx.commit();
    clearJamsCache(id);
    emitEvent(id, jamId, 'instrument_slots_updated', { song_id: song.id_code });
    return res.json({ success: true });
  } catch (e) {
    await tx.rollback();
    return res.status(400).json({ error: 'Validation error', message: e.message });
  }
});

router.put('/:id/jams/:jamId/songs/:songId', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id, jamId, songId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });

  const { title, artist, cover_image, extra_data, key, tempo_bpm, notes, release_batch, status, order_index } = req.body;

  await song.update({
    title: title !== undefined ? title : song.title,
    artist: artist !== undefined ? artist : song.artist,
    cover_image: cover_image !== undefined ? cover_image : song.cover_image,
    extra_data: extra_data !== undefined ? extra_data : song.extra_data,
    key: key !== undefined ? key : song.key,
    tempo_bpm: tempo_bpm !== undefined ? tempo_bpm : song.tempo_bpm,
    notes: notes !== undefined ? notes : song.notes,
    release_batch: release_batch !== undefined ? release_batch : song.release_batch,
    status: status !== undefined ? status : song.status,
    order_index: order_index !== undefined ? order_index : song.order_index
  });

  emitEvent(id, jamId, 'song_updated', { song_id: song.id_code });
  clearJamsCache(id);
  return res.json({ success: true, data: { ...song.toJSON(), id: song.id_code, jam_id: jam.id_code, id_code: undefined } });
});

router.post('/:id/jams/:jamId/songs/release', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id, jamId } = req.params;
  const { song_ids, action } = req.body || {};
  if (!Array.isArray(song_ids) || !song_ids.length) return res.status(400).json({ error: 'Validation error', message: 'song_ids obrigatório' });
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  
  // Resolve numeric IDs from id_codes
  const songs = await EventJamSong.findAll({ where: { id_code: { [Op.in]: song_ids }, jam_id: jam.id } });
  const numericIds = songs.map(s => s.id);
  const foundIdCodes = songs.map(s => s.id_code);

  const maxOpen = parseInt(process.env.JAM_MAX_OPEN_SONGS || '5');
  if (action === 'open') {
    const currentOpen = await EventJamSong.count({ where: { jam_id: jam.id, status: 'open_for_candidates' } });
    if (currentOpen + numericIds.length > maxOpen) return res.status(400).json({ error: 'Validation error', message: 'Limite de músicas abertas excedido' });
    await EventJamSong.update({ status: 'open_for_candidates' }, { where: { id: { [Op.in]: numericIds }, jam_id: jam.id } });
    clearJamsCache(id);
    emitEvent(id, jamId, 'songs_opened', { song_ids: foundIdCodes });
  } else if (action === 'close') {
    await EventJamSong.update({ status: 'planned', ready: false }, { where: { id: { [Op.in]: numericIds }, jam_id: jam.id } });
    const notApproved = await EventJamSongCandidate.findAll({ 
      where: { jam_song_id: { [Op.in]: numericIds }, status: { [Op.ne]: 'approved' } },
      include: [{ model: EventJamSong, as: 'song' }] 
    });
    // Need to verify association alias for EventJamSongCandidate -> EventJamSong. Assuming 'song' or we can fetch manually.
    // If alias is not defined, we can rely on map.
    // But since we have numericIds, let's map back.
    const songIdMap = new Map(songs.map(s => [s.id, s.id_code]));
    
    for (const c of notApproved) {
      await c.update({ status: 'rejected' });
      const sIdCode = songIdMap.get(c.jam_song_id);
      if (sIdCode) {
        emitEvent(id, jamId, 'candidate_rejected', { song_id: sIdCode, instrument: c.instrument });
      }
    }
    emitEvent(id, jamId, 'songs_closed', { song_ids: foundIdCodes });
    clearJamsCache(id);
  } else {
    return res.status(400).json({ error: 'Validation error', message: 'Ação inválida' });
  }
  return res.json({ success: true });
});

router.get('/:id/jams/:jamId/songs/open', async (req, res) => {
  const { id, jamId } = req.params;
  const includeLyrics = String(req.query.include_lyrics || 'false').toLowerCase() === 'true';
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const songs = await EventJamSong.findAll({
    where: { jam_id: jam.id, status: 'open_for_candidates' },
    order: [['order_index', 'ASC']],
    include: [
      { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
      ...(includeLyrics ? [{ model: EventJamMusicCatalog, as: 'catalog', attributes: ['lyrics'] }] : []),
      { model: EventJamSongCandidate, as: 'candidates' },
      { model: EventJamSongRating, as: 'ratings' }
    ]
  });

  let authUserId = null;
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      authUserId = decoded.userId;
    } catch (e) {}
  }
  let myGuest = null;
  if (authUserId) {
    myGuest = await EventGuest.findOne({ where: { event_id: event.id, user_id: authUserId } });
  }
  const data = songs.map(song => {
    const normalizedSlots = normalizeJamInstrumentSlotsRows(song.instrumentSlots || []);
    const slots = normalizedSlots.map(s => {
      const approved = (song.candidates || []).filter(c => c.instrument === s.instrument && c.status === 'approved').length;
      const pending = (song.candidates || []).filter(c => c.instrument === s.instrument && c.status === 'pending').length;
      return { instrument: s.instrument, slots: s.slots, required: s.required, fallback_allowed: s.fallback_allowed, approved_count: approved, pending_count: pending, remaining_slots: Math.max(0, s.slots - approved) };
    });
    const ratings = song.ratings || [];
    const avg = ratings.length ? (ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) : null;
    const requiredCount = slots.filter(s => s.required).length;
    const approvedRequired = slots.filter(s => s.required).reduce((a, s) => a + (s.approved_count > 0 ? 1 : 0), 0);
    const myApp = (myGuest && (song.candidates || []).find(c => c.event_guest_id === myGuest.id)) || null;
    return {
      id: song.id_code,
      jam_id: jam.id_code,
      title: song.title,
      artist: song.artist,
      ...(includeLyrics ? { lyrics: (song.catalog && song.catalog.lyrics) ? song.catalog.lyrics : null } : {}),
      key: song.key,
      tempo_bpm: song.tempo_bpm,
      status: song.status,
      ready: !!song.ready,
      order_index: song.order_index,
      release_batch: song.release_batch,
      instrument_slots: slots,
      my_application: myApp ? { instrument: myApp.instrument, status: myApp.status } : null,
      lineup_completeness: { required_instruments: requiredCount, approved_required: approvedRequired, is_full: approvedRequired === requiredCount },
      rating_summary: ratings.length ? { average: Number(avg.toFixed(2)), count: ratings.length } : null
    };
  });
  return res.json({ success: true, data: { jam: { id: jam.id_code, event_id: event.id_code, name: jam.name, status: jam.status }, songs: data } });
});

router.get('/:id/jams/open', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const includeLyrics = String(req.query.include_lyrics || 'false').toLowerCase() === 'true';
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: req.user.userId } });
  if (!guest || !guest.check_in_at) return res.status(403).json({ error: 'Access denied', message: 'Check-in obrigatório para visualizar' });

  const jams = await EventJam.findAll({ where: { event_id: event.id } });
  const jamIds = jams.map(j => j.id);
  const songs = await EventJamSong.findAll({
    where: { jam_id: { [Op.in]: jamIds }, status: 'open_for_candidates' },
    order: [['order_index', 'ASC']],
    include: [
      { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
      ...(includeLyrics ? [{ model: EventJamMusicCatalog, as: 'catalog', attributes: ['lyrics'] }] : []),
      { model: EventJamSongCandidate, as: 'candidates' },
      { model: EventJamSongRating, as: 'ratings' }
    ]
  });

  const jamsById = jams.reduce((acc, j) => { acc[j.id] = { id: j.id_code, name: j.name, status: j.status }; return acc; }, {});
  const data = songs.map((song, index) => {
    const normalizedSlots = normalizeJamInstrumentSlotsRows(song.instrumentSlots || []);
    const slots = normalizedSlots.map(s => {
      const approved = (song.candidates || []).filter(c => c.instrument === s.instrument && c.status === 'approved').length;
      const pending = (song.candidates || []).filter(c => c.instrument === s.instrument && c.status === 'pending').length;
      return { instrument: s.instrument, slots: s.slots, required: s.required, fallback_allowed: s.fallback_allowed, approved_count: approved, pending_count: pending, remaining_slots: Math.max(0, s.slots - approved) };
    });
    const ratings = song.ratings || [];
    const avg = ratings.length ? (ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) : null;
    const requiredCount = slots.filter(s => s.required).length;
    const approvedRequired = slots.filter(s => s.required).reduce((a, s) => a + (s.approved_count > 0 ? 1 : 0), 0);
    const myApp = (song.candidates || []).find(c => c.event_guest_id === guest.id) || null;
    return {
      jam: jamsById[song.jam_id] || { id: null },
      id: song.id_code,
      jam_id: jamsById[song.jam_id]?.id,
      title: song.title,
      artist: song.artist,
      ...(includeLyrics ? { lyrics: (song.catalog && song.catalog.lyrics) ? song.catalog.lyrics : null } : {}),
      status: song.status,
      ready: !!song.ready,
      order_index: song.order_index,
      queue_position: index + 1,
      release_batch: song.release_batch,
      instrument_slots: slots,
      my_application: myApp ? { instrument: myApp.instrument, status: myApp.status } : null,
      lineup_completeness: { required_instruments: requiredCount, approved_required: approvedRequired, is_full: approvedRequired === requiredCount },
      rating_summary: ratings.length ? { average: Number(avg.toFixed(2)), count: ratings.length } : null
    };
  });
  return res.json({ success: true, data });
});

router.get('/:id/jams/my/on-stage', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: req.user.userId } });
  if (!guest || !guest.check_in_at) return res.status(403).json({ error: 'Access denied', message: 'Check-in obrigatório para visualizar' });
  const jams = await EventJam.findAll({ where: { event_id: event.id } });
  const jamIds = jams.map(j => j.id);
  const globalQueue = await EventJamSong.findAll({
    where: { jam_id: { [Op.in]: jamIds }, status: 'on_stage' },
    order: [['order_index', 'ASC']],
    include: [
      { model: EventJamSongInstrumentSlot, as: 'instrumentSlots' },
      { model: EventJamSongCandidate, as: 'candidates' }
    ]
  });

  const jamsById = jams.reduce((acc, j) => { acc[j.id] = { id: j.id_code, name: j.name, status: j.status }; return acc; }, {});

  const formatSong = (song, index) => {
    const myApp = (song.candidates || []).find(c => c.event_guest_id === guest.id && c.status === 'approved') || null;
    const slots = (song.instrumentSlots || []).map(s => ({ instrument: s.instrument, slots: s.slots, required: s.required, fallback_allowed: s.fallback_allowed }));
    return {
      jam: jamsById[song.jam_id] || { id: null },
      id: song.id_code,
      title: song.title,
      artist: song.artist,
      status: song.status,
      queue_position: index,
      instrument_slots: slots,
      my_application: myApp ? { instrument: myApp.instrument, status: myApp.status } : null
    };
  };

  const nowPlaying = globalQueue.length > 0 ? formatSong(globalQueue[0], 1) : null;
  const myUpcoming = globalQueue.map((s, i) => {
    // If it's the first song (now playing), check if it's mine too.
    // The user wants to know if they are on stage NOW or UPCOMING.
    // So 'my_upcoming' should probably be 'my_songs' or we separate 'my_now_playing' and 'my_queue'.
    // The current logic skips index 0 for my_upcoming, assuming index 0 is 'now_playing'.
    // But if I am in 'now_playing', I want to know.
    
    // Let's keep 'now_playing' as the general Stage song.
    // And 'my_upcoming' as the list of songs I am approved for (including the one on stage if applicable, or maybe strictly upcoming).
    // The previous logic was:
    /*
    if (i === 0) return null;
    const isMine = ...
    */
    
    // If the requirement is "listar as músicas que estão no palco para a home dos usuários", 
    // it usually implies "What is currently playing?" (General) AND "When do I play?" (Personal).
    
    // Let's include ALL my approved songs in 'my_upcoming' (or rename to 'my_songs' in front, but keep key for compatibility),
    // potentially marking them as 'on_stage' or 'in_queue'.
    
    const isMine = (s.candidates || []).some(c => c.event_guest_id === guest.id && c.status === 'approved');
    if (!isMine) return null;
    
    // If it is the first song, it is ON STAGE.
    // If it is later, it is UPCOMING.
    return formatSong(s, i + 1);
  }).filter(Boolean);

  return res.json({ success: true, data: { now_playing: nowPlaying, my_upcoming: myUpcoming } });
});

router.get('/:id/jams/playlist', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  
  const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: req.user.userId } });
  if (!guest || !guest.check_in_at) return res.status(403).json({ error: 'Access denied', message: 'Check-in obrigatório para visualizar' });

  const jams = await EventJam.findAll({ where: { event_id: event.id } });
  const jamIds = jams.map(j => j.id);

  const songs = await EventJamSong.findAll({
    where: { 
      jam_id: { [Op.in]: jamIds }, 
      status: 'on_stage' 
    },
    order: [['order_index', 'ASC']],
    include: [
      { 
        model: EventJamSongCandidate, 
        as: 'candidates', 
        where: { status: 'approved' },
        required: false, 
        include: [{ model: EventGuest, as: 'guest', include: [{ model: User, as: 'user', attributes: ['name', 'avatar_url'] }] }]
      }
    ]
  });

  const jamsById = jams.reduce((acc, j) => { acc[j.id] = { id: j.id_code, name: j.name, status: j.status }; return acc; }, {});

  const data = songs.map((song, index) => {
    const musicians = (song.candidates || []).map(c => {
      const name = c.guest?.user?.name || c.guest?.guest_name || 'Unknown';
      const avatar_url = c.guest?.selfie_url || c.guest?.user?.avatar_url || null;
      return { 
        name, 
        avatar_url, 
        instrument: c.instrument 
      };
    });

    return {
      jam: jamsById[song.jam_id] || { id: null },
      id: song.id_code,
      title: song.title,
      artist: song.artist,
      status: song.status,
      queue_position: index + 1,
      musicians
    };
  });

  return res.json({ success: true, data });
});

router.get('/:id/jam', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: req.user.userId } });
  if (!guest || !guest.check_in_at) return res.status(403).json({ error: 'Access denied', message: 'Check-in obrigatório para visualizar' });
  const jam = await EventJam.findOne({ where: { event_id: event.id }, order: [['order_index', 'ASC']] });
  return res.json({ success: true, data: { jam_id: jam ? jam.id_code : null } });
});

router.get('/stream-test', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const write = () => {
    const payload = { type: 'stream_test', time: new Date().toISOString(), random: Math.floor(Math.random() * 1000000) };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  write();
  const intervalId = setInterval(write, 2000);
  req.on('close', () => {
    clearInterval(intervalId);
  });
});

router.post('/:id/jams/:jamId/songs/:songId/apply', authenticateToken, [
  body('instrument').isString()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId, songId } = req.params;
  const { instrument } = req.body;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song || song.status !== 'open_for_candidates') return res.status(400).json({ error: 'Validation error', message: 'Música indisponível para candidatura' });
  const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: req.user.userId } });
  if (!guest) return res.status(404).json({ error: 'Not Found', message: 'Convidado não encontrado no evento' });
  if (!guest.check_in_at) return res.status(403).json({ error: 'Access denied', message: 'Check-in obrigatório para candidatar-se' });
  const exists = await EventJamSongCandidate.findOne({ where: { jam_song_id: song.id, instrument, event_guest_id: guest.id } });
  if (exists) return res.status(409).json({ error: 'Duplicate entry', message: 'Já candidatado' });
  const created = await EventJamSongCandidate.create({ jam_song_id: song.id, instrument, event_guest_id: guest.id, status: 'pending' });
  emitEvent(id, jamId, 'candidate_applied', { song_id: song.id_code, instrument });
  clearJamsCache(id);
  return res.status(201).json({ success: true, data: { ...created.toJSON(), id: created.id_code, jam_song_id: song.id_code, event_guest_id: guest.id_code, id_code: undefined } });
});

router.post('/:id/jams/:jamId/songs/:songId/candidates/:candidateId/approve', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id, jamId, songId, candidateId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  const candidate = await EventJamSongCandidate.findOne({ where: { id_code: candidateId, jam_song_id: song.id } });
  if (!candidate) return res.status(404).json({ error: 'Not Found', message: 'Candidato não encontrado' });
  const slot = await EventJamSongInstrumentSlot.findOne({ where: { jam_song_id: song.id, instrument: candidate.instrument } });
  if (!slot) return res.status(400).json({ error: 'Validation error', message: 'Instrumento não configurado' });
  const approvedCount = await EventJamSongCandidate.count({ where: { jam_song_id: song.id, instrument: candidate.instrument, status: 'approved' } });
  if (approvedCount >= (slot.slots || 1)) return res.status(400).json({ error: 'Validation error', message: 'Vagas preenchidas' });
  await candidate.update({ status: 'approved', approved_at: new Date(), approved_by_user_id: req.user.userId });
  emitEvent(id, jamId, 'candidate_approved', { song_id: song.id_code, instrument: candidate.instrument });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.post('/:id/jams/:jamId/songs/:songId/candidates/:candidateId/reject', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id, jamId, songId, candidateId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  const candidate = await EventJamSongCandidate.findOne({ where: { id_code: candidateId, jam_song_id: song.id } });
  if (!candidate) return res.status(404).json({ error: 'Not Found', message: 'Candidato não encontrado' });
  await candidate.update({ status: 'rejected' });
  emitEvent(id, jamId, 'candidate_rejected', { song_id: song.id_code, instrument: candidate.instrument });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.post('/:id/jams/:jamId/songs/:songId/move', authenticateToken, requireRole('admin', 'master'), [
  body('status').isIn(['planned','open_for_candidates','on_stage','played','canceled'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId, songId } = req.params;
  const { status } = req.body;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  if (status === 'planned') {
    await song.update({ status: 'planned', ready: false });
  } else if (status === 'open_for_candidates') {
    await song.update({ status: 'open_for_candidates' });
  } else if (status === 'on_stage' || status === 'played') {
    if (!song.ready) return res.status(400).json({ error: 'Validation error', message: 'Música precisa estar aprovada (ready=true) para avançar' });
    await song.update({ status });
  } else if (status === 'canceled') {
    await song.update({ status: 'canceled' });
  }
  emitEvent(id, jamId, 'song_status_changed', { song_id: song.id_code, status });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.patch('/:id/jams/:jamId/songs/:songId/status', authenticateToken, requireRole('admin', 'master'), [
  body('status').isIn(['planned','open_for_candidates','on_stage','played','canceled'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId, songId } = req.params;
  const { status } = req.body;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  if (status === 'planned') {
    await song.update({ status: 'planned', ready: false });
  } else if (status === 'open_for_candidates') {
    await song.update({ status: 'open_for_candidates' });
  } else if (status === 'on_stage' || status === 'played') {
    if (!song.ready) return res.status(400).json({ error: 'Validation error', message: 'Música precisa estar aprovada (ready=true) para avançar' });
    await song.update({ status });
  } else if (status === 'canceled') {
    await song.update({ status: 'canceled' });
  }
  emitEvent(id, jamId, 'song_status_changed', { song_id: song.id_code, status });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.patch('/:id/jams/:jamId/songs/:songId/ready', authenticateToken, requireRole('admin', 'master'), [
  body('ready').isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId, songId } = req.params;
  const { ready } = req.body;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  if (song.status !== 'open_for_candidates') return res.status(400).json({ error: 'Validation error', message: 'Toggle permitido apenas em open_for_candidates' });
  await song.update({ ready: !!ready });
  emitEvent(id, jamId, 'song_ready_changed', { song_id: song.id_code, ready: !!ready });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.patch('/:id/jams/:jamId/songs/order', authenticateToken, requireRole('admin', 'master'), [
  body('status').isIn(['planned','open_for_candidates','on_stage','played','canceled']),
  body('ordered_ids').isArray()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId } = req.params;
  const { status, ordered_ids } = req.body;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  
  // Fetch songs by status
  const songs = await EventJamSong.findAll({ where: { jam_id: jam.id, status }, order: [['order_index','ASC']] });
  
  // Map ordered_ids (UUIDs) to internal song objects
  const songMap = new Map(songs.map(s => [s.id_code, s]));
  const ordered = ordered_ids.map(uuid => songMap.get(uuid)).filter(Boolean);
  
  if (ordered.length !== ordered_ids.length) {
    // Some IDs were not found or invalid
    return res.status(400).json({ error: 'Validation error', message: 'ordered_ids contém itens inválidos ou fora do status' });
  }

  let idx = 0;
  for (const s of ordered) {
    await s.update({ order_index: idx++ });
  }
  
  // Update any remaining songs not in ordered_ids (append them)
  const orderedSet = new Set(ordered.map(s => s.id));
  for (const s of songs) {
    if (!orderedSet.has(s.id)) {
      await s.update({ order_index: idx++ });
    }
  }

  emitEvent(id, jamId, 'song_order_changed', { status, ordered_ids });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.get('/:id/jams/:jamId/users/:userId/queue-position', authenticateToken, async (req, res) => {
  const { id, jamId, userId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  
  // userId from params is likely id_code if consistent with other changes, but here it seems to be user ID or guest ID?
  // User says "entrada sempre é por id_code".
  // But userId param usually refers to User.id or User.id_code?
  // Let's assume User.id_code because of consistency.
  // But line 802 uses parseInt(userId, 10).
  // If input is UUID, parseInt is NaN.
  // I should fetch User by id_code.
  
  let targetUserId = null;
  const targetUser = await User.findOne({ where: { id_code: userId } });
  if (targetUser) targetUserId = targetUser.id;
  
  if (!targetUserId) {
     // Fallback to integer check if old client? Or error?
     // Let's assume strictly UUID now.
     return res.status(404).json({ error: 'Not Found', message: 'Usuário não encontrado' });
  }

  if (req.user.role !== 'master' && req.user.role !== 'admin' && req.user.userId !== targetUserId) return res.status(403).json({ error: 'Access denied' });
  
  const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: targetUserId } });
  if (!guest) return res.status(404).json({ error: 'Not Found', message: 'Convidado não encontrado no evento' });
  
  const queue = await EventJamSong.findAll({ where: { jam_id: jam.id, status: 'open_for_candidates', ready: true }, order: [['order_index','ASC']] });
  const approved = await EventJamSongCandidate.findAll({ where: { event_guest_id: guest.id, status: 'approved', jam_song_id: { [Op.in]: queue.map(s => s.id) } } });
  
  const songIdMap = new Map(queue.map(s => [s.id, s.id_code]));
  
  const positions = approved.map(a => {
    const idx = queue.findIndex(s => s.id === a.jam_song_id);
    const sIdCode = songIdMap.get(a.jam_song_id);
    return { songId: sIdCode, position: idx >= 0 ? (idx + 1) : null };
  }).filter(p => p.position != null);
  
  return res.json({ success: true, data: { positions, total: queue.length } });
});

router.delete('/:id/jams/:jamId/songs/:songId', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const { id, jamId, songId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  const status = song.status;
  await EventJamSongCandidate.destroy({ where: { jam_song_id: song.id } });
  await EventJamSongInstrumentSlot.destroy({ where: { jam_song_id: song.id } });
  await EventJamSongRating.destroy({ where: { jam_song_id: song.id } });
  await song.destroy();
  
  const rest = await EventJamSong.findAll({ where: { jam_id: jam.id, status }, order: [['order_index','ASC']] });
  let idx = 0;
  for (const s of rest) { await s.update({ order_index: idx++ }); }
  
  emitEvent(id, jamId, 'song_deleted', { song_id: songId });
  emitEvent(id, jamId, 'song_order_changed', { status, ordered_ids: rest.map(s => s.id_code) });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.post('/:id/jams/:jamId/songs/:songId/rate', authenticateToken, [
  body('stars').isInt({ min: 1, max: 5 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });
  const { id, jamId, songId } = req.params;
  const { stars } = req.body;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  if (song.status !== 'played') return res.status(400).json({ error: 'Validation error', message: 'Avaliação permitida apenas após tocar' });
  const [rating, created] = await EventJamSongRating.findOrCreate({ where: { jam_song_id: song.id, user_id: req.user.userId }, defaults: { jam_song_id: song.id, user_id: req.user.userId, stars } });
  if (!created) await rating.update({ stars, rated_at: new Date() });
  const count = await EventJamSongRating.count({ where: { jam_song_id: song.id } });
  const aggregate = await EventJamSongRating.findAll({ where: { jam_song_id: song.id } });
  const avg = aggregate.length ? (aggregate.reduce((a, r) => a + r.stars, 0) / aggregate.length) : 0;
  emitEvent(id, jamId, 'rating_summary_updated', { song_id: song.id_code, average: Number(avg.toFixed(2)), count });
  clearJamsCache(id);
  return res.json({ success: true });
});

router.get('/:id/jams/:jamId/songs/:songId/ratings', async (req, res) => {
  const { id, jamId, songId } = req.params;
  const event = await Event.findOne({ where: { id_code: id } });
  if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
  const jam = await EventJam.findOne({ where: { id_code: jamId, event_id: event.id } });
  if (!jam) return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
  const song = await EventJamSong.findOne({ where: { id_code: songId, jam_id: jam.id } });
  if (!song) return res.status(404).json({ error: 'Not Found', message: 'Música não encontrada' });
  const ratings = await EventJamSongRating.findAll({ where: { jam_song_id: song.id } });
  const avg = ratings.length ? (ratings.reduce((a, r) => a + r.stars, 0) / ratings.length) : 0;
  return res.json({ success: true, data: { average: ratings.length ? Number(avg.toFixed(2)) : null, count: ratings.length } });
});

module.exports = router;
