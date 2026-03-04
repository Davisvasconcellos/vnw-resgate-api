const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireModule } = require('../middlewares/auth');
const jwt = require('jsonwebtoken'); // Import JWT for manual verification
const { TokenBlocklist, User } = require('../models'); // Import Blocklist
const { Op } = require('sequelize');
const admin = require('../config/firebaseAdmin'); // Import Firebase Admin

// Middleware opcional para extrair usuário se token existir
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token) {
    try {
      // Corrigido: buscar por coluna 'token', não PK (que é inteiro)
      // Usar o mesmo cache de blocklist que o middleware principal
      const isBlocked = await TokenBlocklist.findOne({ where: { token } });
      
      if (!isBlocked) {
        // 1. Tenta validar como JWT da aplicação
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log('[DEBUG] optionalAuth: App Token valid. User:', decoded);
        req.user = decoded;
      } else {
        console.log('[DEBUG] optionalAuth: Token blocked');
      }
    } catch (err) {
      console.error('[DEBUG] optionalAuth: App Token verification failed:', err.message);
      
      // 2. Fallback: Tenta validar como Token do Firebase (Google)
      try {
        console.log('[DEBUG] optionalAuth: Trying Firebase verification...');
        const decodedToken = await admin.auth().verifyIdToken(token);
        console.log('[DEBUG] optionalAuth: Firebase Token valid. Email:', decodedToken.email);
        
        // Busca usuário pelo email do Firebase
        const user = await User.findOne({ where: { email: decodedToken.email } });
        if (user) {
           req.user = { userId: user.id, email: user.email, role: user.role };
           console.log('[DEBUG] optionalAuth: Mapped Firebase User to App User ID:', user.id);
        } else {
           console.log('[DEBUG] optionalAuth: Firebase User not found in DB');
        }
      } catch (firebaseErr) {
        console.error('[DEBUG] optionalAuth: Firebase verification failed:', firebaseErr.message);
      }
    }
  } else {
    console.log('[DEBUG] optionalAuth: No token provided');
  }
  next();
};

const {
  EventJamMusicSuggestion,
  EventJamMusicSuggestionParticipant,
  EventJam,
  EventJamSong,
  EventJamSongInstrumentSlot,
  EventJamSongCandidate,
  EventGuest,
  Event,
  EventJamMusicCatalog
} = require('../models');
const { incrementMetric } = require('../utils/requestContext');
const { suggestionsCache, clearSuggestionsCache, clearJamsCache, SUGGESTIONS_CACHE_TTL } = require('../utils/cacheManager');

const router = express.Router();

/**
 * 0. Buscar Amigos (Usuários no mesmo evento)
 * GET /api/v1/music-suggestions/friends
 * Query Params:
 *  - event_id: UUID do evento (obrigatório)
 *  - q: Filtro por nome (opcional)
 */
router.get('/friends', optionalAuth, async (req, res) => {
  try {
    // Validar se usuário está logado
    if (!req.user || !req.user.userId) {
       return res.status(401).json({ error: 'Unauthorized', message: 'Token inválido ou expirado.' });
    }

    const userId = req.user.userId;
    const { q, event_id } = req.query;

    if (!event_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'event_id é obrigatório' });
    }

    // Buscar o evento pelo UUID para pegar o ID interno
    const event = await Event.findOne({ where: { id_code: event_id } });
    
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    // Buscar usuários checked-in neste evento específico
    const whereClause = {
      event_id: event.id,
      check_in_at: { [Op.ne]: null },
      user_id: { [Op.ne]: null, [Op.ne]: userId } // Exclui guests sem user vinculado e o próprio usuário
    };

    // Filtro por nome
    const userWhere = {};
    if (q) {
      userWhere.name = { [Op.like]: `%${q}%` };
    }

    const friends = await EventGuest.findAll({
      where: whereClause,
      include: [{
        model: User,
        as: 'user',
        where: userWhere,
        attributes: ['id', 'id_code', 'name', 'avatar_url', 'email']
      }],
      limit: 20 // Limitar resultados
    });

    // Mapear para formato simples
    const data = friends.map(g => ({
      user_id: g.user.id_code, // UUID para o front (usado para convidar)
      id: g.user.id_code, // Alias para compatibilidade com componentes de UI que esperam 'id'
      value: g.user.id_code, // Alias para componentes do tipo Select
      label: g.user.name, // Alias para componentes do tipo Select
      guest_id: g.id, // ID interno do guest (útil para debug ou admin)
      name: g.user.name,
      avatar_url: g.user.avatar_url,
      check_in_at: g.check_in_at,
      instrument: null // Placeholder para o front preencher/selecionar
    }));

    return res.json({ success: true, data });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

/**
 * 1. Listagem e Detalhes
 * GET /api/v1/music-suggestions
 * Query Params:
 *  - event_id: UUID do evento (obrigatório)
 */
// Caches were moved to src/utils/cacheManager.js for cross-route invalidation

router.get('/', optionalAuth, async (req, res) => {
  try {
    const userId = req.user ? req.user.userId : null;
    const { event_id, status } = req.query;
    let guestId = null;

    if (!event_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'event_id é obrigatório' });
    }

    const event = await Event.findOne({ where: { id_code: event_id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    // Resolve Guest ID if not logged in
    if (!userId) {
       // Check multiple sources just like in POST
       const guestIdCode = req.query.guest_id || req.headers['x-guest-id'];
       if (guestIdCode) {
         // Try to find by UUID first
         let guest = await EventGuest.findOne({ where: { id_code: guestIdCode, event_id: event.id } });
         
         // Fallback to integer ID if UUID not found
         if (!guest && !isNaN(parseInt(guestIdCode))) {
            guest = await EventGuest.findOne({ where: { id: guestIdCode, event_id: event.id } });
         }

         if (guest) {
            guestId = guest.id;
            if (guest.user_id) {
               // If guest is linked to user, prefer user logic but keep guestId for redundancy
               // userId = guest.user_id; // Unsafe to auto-login user without token
            }
         }
       }
    }

    // Cache key includes status and user role/ID to ensure correct permissions are cached
    const isSpecialRole = req.user && ['admin', 'master'].includes(req.user.role);
    const cacheKey = `${event_id}-${status || 'default'}-${isSpecialRole ? 'admin' : (userId || guestId || 'guest')}`;

    // Check cache (SKIP for now to debug guest logic, or ensure key is unique)
    // ...

    // Configurar cláusula where baseada no papel do usuário
    let whereClause = {
      event_id: event.id
    };

    // Se for Admin ou Master, permite ver sugestões SUBMITTED (para aprovação)
    // ou filtrar por status via query param
    if (isSpecialRole) {
      if (status && status !== 'ALL') {
        if (status.includes(',')) {
          whereClause.status = { [Op.in]: status.split(',').map(s => s.trim()) };
        } else {
          whereClause.status = status;
        }
      } else if (!status) {
        whereClause.status = 'SUBMITTED';
      }
    } else {
      // Usuário comum ou Guest: vê apenas as suas (criador ou participante)
      const orConditions = [];
      
      if (userId) {
        orConditions.push({ created_by_user_id: userId });
        orConditions.push({ '$participants.user_id$': userId });
      }
      
      if (guestId) {
        orConditions.push({ created_by_guest_id: guestId });
        orConditions.push({ '$participants.guest_id$': guestId });
      }

      // If no identity, return nothing (or public suggestions if we had that concept)
      if (orConditions.length > 0) {
        whereClause[Op.or] = orConditions;
      } else {
        // Return empty if unknown user
        console.log('[DEBUG] GET /music-suggestions: No user or guest identified. Returning empty list.');
        return res.json({ success: true, data: [] });
      }
    }

    const suggestions = await EventJamMusicSuggestion.findAll({
      include: [
        {
          model: EventJamMusicSuggestionParticipant,
          as: 'participants',
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'id_code', 'name', 'avatar_url', 'email']
            },
            {
              model: EventGuest,
              as: 'guest',
              attributes: ['id', 'id_code', 'guest_name', 'selfie_url']
            }
          ]
        },
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'id_code', 'name', 'avatar_url']
        },
        {
          model: EventGuest,
          as: 'guestCreator',
          attributes: ['id', 'id_code', 'guest_name', 'selfie_url']
        }
      ],
      where: whereClause,
      order: [['created_at', 'DESC']]
    });

    // Processar sugestões para adicionar campos computados úteis para o front
    const data = suggestions.map(s => {
      // Usar get({ plain: true }) para garantir objeto plano sem referências circulares
      const sJSON = s.get({ plain: true });
      
      // Contagens de status
      // IMPORTANTE: Usar sJSON.participants (já plano) em vez de s.participants
      const participants = sJSON.participants || [];
      
      const totalParticipants = participants.length;
      const acceptedCount = participants.filter(p => p.status === 'ACCEPTED').length;
      const pendingCount = participants.filter(p => p.status === 'PENDING').length;
      const rejectedCount = participants.filter(p => p.status === 'REJECTED').length;

      // Flag para saber se o usuário atual já aceitou (se for convidado)
      // Check both user_id and guest_id match
      const myParticipation = participants.find(p => {
        if (userId && p.user_id === userId) return true;
        if (guestId && p.guest_id === guestId) return true;
        return false;
      }) || null;
      
      const amICreator = (userId && sJSON.created_by_user_id === userId) || (guestId && sJSON.created_by_guest_id === guestId);

      // Status "virtual" para exibição no card
      // Se todos aceitaram e sou o criador, posso enviar
      const canSubmit = amICreator && pendingCount === 0 && rejectedCount === 0 && sJSON.status === 'DRAFT';

      // Normalize creator info for frontend
      let creatorInfo = {};
      if (sJSON.creator) {
        creatorInfo = { name: sJSON.creator.name, avatar: sJSON.creator.avatar_url, id: sJSON.creator.id_code };
      } else if (sJSON.guestCreator) {
        creatorInfo = { name: sJSON.guestCreator.guest_name, avatar: sJSON.guestCreator.selfie_url, id: sJSON.guestCreator.id_code };
      }

      // Normalize participants info
      const participantsNormalized = participants.map(p => {
        let pInfo = { ...p }; // Agora 'p' é um objeto plano, então spread é seguro
        if (p.user) {
          pInfo.name = p.user.name;
          pInfo.avatar = p.user.avatar_url;
          pInfo.id_code = p.user.id_code;
        } else if (p.guest) {
          pInfo.name = p.guest.guest_name;
          pInfo.avatar = p.guest.selfie_url;
          pInfo.id_code = p.guest.id_code;
        }
        return pInfo;
      });

      return {
        ...sJSON,
        creator: creatorInfo,
        participants: participantsNormalized,
        stats: {
          total: totalParticipants,
          accepted: acceptedCount,
          pending: pendingCount,
          rejected: rejectedCount
        },
        user_context: {
          is_creator: !!amICreator,
          my_status: myParticipation ? myParticipation.status : null,
          can_submit: !!canSubmit
        }
      };
    });

    return res.json({ success: true, data });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

/**
 * 2. Criar Nova Sugestão
 * POST /api/v1/music-suggestions
 */
router.post('/',
  optionalAuth,
  [
    body('event_id').isUUID().withMessage('ID do evento é obrigatório'),
    body('song_name').notEmpty().withMessage('Nome da música é obrigatório'),
    body('artist_name').notEmpty().withMessage('Nome do artista é obrigatório'),
    body('my_instrument').notEmpty().withMessage('Seu instrumento é obrigatório'),
    body('cover_image').optional().isString(),
    body('extra_data').optional(),
    body('invites').optional().isArray(),
    body('invites.*.user_id').isUUID(),
    body('invites.*.instrument').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    // Regra de Negócio: Todo usuário deve estar logado na plataforma (User)
    // O conceito de "Guest" é apenas o vínculo com o evento.
    
    // 1. Validar Token/Usuário
    if (!req.user || !req.user.userId) {
       console.log('[DEBUG] POST /music-suggestions: Bloqueado por falta de token válido.');
       return res.status(401).json({ error: 'Unauthorized', message: 'Token inválido ou expirado. Faça login novamente.' });
    }
    
    const { event_id, song_name, artist_name, my_instrument, cover_image, extra_data, invites = [], catalog_id } = req.body;
    
    const userId = req.user.userId;
    console.log('[DEBUG] User ID from Token:', userId);

    // 2. Validar Evento
    const event = await Event.findOne({ where: { id_code: event_id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });

    // 3. Verificar status do evento
    if (event.status === 'canceled' || event.status === 'paused') {
      return res.status(400).json({ 
        error: 'Event Unavailable', 
        message: `Este evento está ${event.status === 'canceled' ? 'cancelado' : 'pausado'} e não aceita novas sugestões.` 
      });
    }

    // 4. Buscar o Guest vinculado a este usuário e evento
    // (O usuário já deve ter feito check-in anteriormente)
    let guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: userId } });
    
    // Fallback: Se não achar por user_id, tenta por email (caso o check-in tenha sido feito antes do vínculo de conta, embora raro com login obrigatório)
    if (!guest) {
       const user = await User.findByPk(userId);
       if (user && user.email) {
          guest = await EventGuest.findOne({ 
             where: { 
                event_id: event.id, 
                guest_email: user.email 
             } 
          });
          
          // Se achou por email mas não tinha user_id, atualiza agora (self-healing)
          if (guest && !guest.user_id) {
             await guest.update({ user_id: userId });
          }
       }
    }

    if (!guest) {
       // Se não tem guest, significa que não fez check-in
       return res.status(403).json({ error: 'Forbidden', message: 'Você precisa fazer check-in no evento antes de sugerir músicas.' });
    }

    const guestId = guest.id;
    console.log('[DEBUG] Guest Found:', guestId);

    // 5. Validar catalog_id se fornecido
    let catalogEntry = null;
    if (catalog_id) {
        catalogEntry = await EventJamMusicCatalog.findByPk(catalog_id);
        if (!catalogEntry) {
            console.warn(`Catalog ID ${catalog_id} not found, ignoring link.`);
        }
    }

    const transaction = await EventJamMusicSuggestion.sequelize.transaction();

    try {
      // Criar a sugestão vinculada a AMBOS (User e Guest)
      const suggestionData = {
        event_id: event.id,
        song_name,
        artist_name,
        cover_image,
        extra_data,
        catalog_id: catalogEntry ? catalogEntry.id : null,
        status: 'DRAFT',
        created_by_user_id: userId,
        created_by_guest_id: guestId
      };

      const suggestion = await EventJamMusicSuggestion.create(suggestionData, { transaction });

      // Se veio do catálogo, incrementa o contador
      if (catalogEntry) {
        await catalogEntry.increment('usage_count', { transaction });
      }

      // Adicionar o criador como participante (ACCEPTED)
      const participantData = {
        music_suggestion_id: suggestion.id,
        instrument: my_instrument,
        is_creator: true,
        status: 'ACCEPTED',
        user_id: userId,
        guest_id: guestId
      };

      await EventJamMusicSuggestionParticipant.create(participantData, { transaction });

      // Processar convites
      if (invites.length > 0) {
        // Buscar IDs internos dos usuários convidados
        const uuids = invites.map(i => i.user_id);
        const users = await User.findAll({ where: { id_code: uuids }, attributes: ['id', 'id_code'] });
        const userMap = new Map(users.map(u => [u.id_code, u.id]));

        for (const invite of invites) {
          const invitedUserId = userMap.get(invite.user_id);
          if (invitedUserId) {
            // Tenta achar o guest do convidado também (opcional, mas bom para consistência)
            const invitedGuest = await EventGuest.findOne({ where: { event_id: event.id, user_id: invitedUserId } });
            
            await EventJamMusicSuggestionParticipant.create({
              music_suggestion_id: suggestion.id,
              user_id: invitedUserId,
              guest_id: invitedGuest ? invitedGuest.id : null, // Pode ser null se o convidado ainda não fez check-in
              instrument: invite.instrument,
              is_creator: false,
              status: 'PENDING'
            }, { transaction });
          }
        }
      }

      await transaction.commit();
      clearSuggestionsCache(event_id);

      // Recarregar com associações para retorno
      const fullSuggestion = await EventJamMusicSuggestion.findByPk(suggestion.id, {
        include: [{
          model: EventJamMusicSuggestionParticipant,
          as: 'participants',
          include: [
            { model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'avatar_url'] },
            { model: EventGuest, as: 'guest', attributes: ['id', 'id_code', 'guest_name', 'selfie_url'] }
          ]
        }]
      });

      return res.status(201).json({ success: true, data: fullSuggestion });

    } catch (error) {
      await transaction.rollback();
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
);

/**
 * 2.1 Editar Sugestão (PUT)
 * PUT /api/v1/music-suggestions/:id
 */
router.put('/:id',
  optionalAuth,
  [
    body('song_name').optional().notEmpty(),
    body('artist_name').optional().notEmpty(),
    body('cover_image').optional().isString(),
    body('extra_data').optional()
  ],
  async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ error: 'Unauthorized' });
      const { id } = req.params;
      const userId = req.user.userId;

      const suggestion = await EventJamMusicSuggestion.findOne({ 
        where: { 
          [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }]
        } 
      });

      if (!suggestion) return res.status(404).json({ error: 'Not Found', message: 'Sugestão não encontrada' });

      let isOwner = suggestion.created_by_user_id === userId;
      if (!isOwner && suggestion.created_by_guest_id) {
         let guest = await EventGuest.findOne({ where: { user_id: userId, event_id: suggestion.event_id } });
         
         // Fallback: Tenta achar por email se não tiver user_id vinculado
         if (!guest) {
             const user = await User.findByPk(userId);
             if (user && user.email) {
                 guest = await EventGuest.findOne({ where: { guest_email: user.email, event_id: suggestion.event_id } });
                 if (guest && !guest.user_id) {
                     await guest.update({ user_id: userId });
                 }
             }
         }

         if (guest && guest.id === suggestion.created_by_guest_id) isOwner = true;
      }

      // Permitir admin ou criador
      if (!isOwner && !['admin', 'master'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden', message: 'Apenas o criador ou admin pode editar' });
      }

      // Se for admin, pode editar em qualquer status. Se for criador, só DRAFT.
      if (!['admin', 'master'].includes(req.user.role) && suggestion.status !== 'DRAFT') {
        return res.status(400).json({ error: 'Bad Request', message: 'Apenas sugestões em rascunho podem ser editadas' });
      }

      await suggestion.update(req.body);
      clearSuggestionsCache(suggestion.event_id_code || id);

      return res.json({ success: true, data: suggestion });
    } catch (error) {
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
);

/**
 * 2.2 Rejeitar Sugestão (REJECT)
 * POST /api/v1/music-suggestions/:id/reject
 */
router.post('/:id/reject', authenticateToken, requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    // Apenas admins podem rejeitar
    if (!['admin', 'master'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Apenas administradores podem rejeitar sugestões' });
    }

    const suggestion = await EventJamMusicSuggestion.findOne({ 
      where: { 
        [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }]
      } 
    });

    if (!suggestion) return res.status(404).json({ error: 'Not Found', message: 'Sugestão não encontrada' });

    if (suggestion.status === 'REJECTED') {
      return res.status(400).json({ error: 'Bad Request', message: 'Sugestão já está rejeitada' });
    }

    suggestion.status = 'REJECTED';
    await suggestion.save();
    clearSuggestionsCache(suggestion.event_id_code || id);

    return res.json({ success: true, message: 'Sugestão rejeitada com sucesso', data: suggestion });
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

/**
 * 2.3 Excluir Sugestão (DELETE)
 * DELETE /api/v1/music-suggestions/:id
 */
router.delete('/:id', optionalAuth, async (req, res) => {
  try {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    const userId = req.user.userId;

    const suggestion = await EventJamMusicSuggestion.findOne({ 
      where: { 
        [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }]
      } 
    });

    if (!suggestion) return res.status(404).json({ error: 'Not Found', message: 'Sugestão não encontrada' });

    let isOwner = suggestion.created_by_user_id === userId;
    if (!isOwner && suggestion.created_by_guest_id) {
       let guest = await EventGuest.findOne({ where: { user_id: userId, event_id: suggestion.event_id } });
       
       // Self-healing: Try by email if user_id link is missing
       if (!guest) {
           const user = await User.findByPk(userId);
           if (user && user.email) {
               guest = await EventGuest.findOne({ where: { guest_email: user.email, event_id: suggestion.event_id } });
               if (guest && !guest.user_id) {
                   await guest.update({ user_id: userId });
               }
           }
       }

       if (guest && guest.id === suggestion.created_by_guest_id) isOwner = true;
    }

    if (!isOwner && !['admin', 'master'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Apenas o criador ou admin pode excluir' });
    }

    await suggestion.destroy();
    if (suggestion.event_id) {
       const event = await Event.findByPk(suggestion.event_id);
       if (event) clearSuggestionsCache(event.id_code);
    }
    return res.json({ success: true, message: 'Sugestão excluída com sucesso' });
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

/**
 * 2.3 Enviar Sugestão (SUBMIT)
 * POST /api/v1/music-suggestions/:id/submit
 */
router.post('/:id/submit', optionalAuth, async (req, res) => {
  try {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;
    const userId = req.user.userId;

    const suggestion = await EventJamMusicSuggestion.findOne({ 
      where: { 
        [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }]
      },
      include: [{ model: EventJamMusicSuggestionParticipant, as: 'participants' }]
    });

    if (!suggestion) return res.status(404).json({ error: 'Not Found', message: 'Sugestão não encontrada' });

    let isOwner = suggestion.created_by_user_id === userId;
    if (!isOwner && suggestion.created_by_guest_id) {
       let guest = await EventGuest.findOne({ where: { user_id: userId, event_id: suggestion.event_id } });
       
       if (!guest) {
           const user = await User.findByPk(userId);
           if (user && user.email) {
               guest = await EventGuest.findOne({ where: { guest_email: user.email, event_id: suggestion.event_id } });
               if (guest && !guest.user_id) {
                   await guest.update({ user_id: userId });
               }
           }
       }

       if (guest && guest.id === suggestion.created_by_guest_id) isOwner = true;
    }

    if (!isOwner) {
      return res.status(403).json({ error: 'Forbidden', message: 'Apenas o criador pode enviar a sugestão' });
    }

    // Validação: Todos os convidados devem estar ACCEPTED
    // Filtra participantes que NÃO são o criador e que NÃO estão ACCEPTED
    const pendingParticipants = suggestion.participants.filter(p => !p.is_creator && p.status !== 'ACCEPTED');

    if (pendingParticipants.length > 0) {
      return res.status(400).json({ 
        error: 'Validation Error', 
        message: 'Todos os convidados devem aceitar o convite antes do envio.',
        pending_participants: pendingParticipants.map(p => p.id)
      });
    }

    suggestion.status = 'SUBMITTED';
    await suggestion.save();
    if (suggestion.event_id) {
       const event = await Event.findByPk(suggestion.event_id);
       if (event) clearSuggestionsCache(event.id_code);
    }

    return res.json({ success: true, data: suggestion, message: 'Sugestão enviada para aprovação!' });

  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

/**
 * 3. Gerenciamento de Participantes
 * POST /api/v1/music-suggestions/:id/participants
 */
router.post('/:id/participants', 
  optionalAuth, 
  [
    body('user_id').isUUID().withMessage('ID do usuário inválido'),
    body('instrument').notEmpty().withMessage('Instrumento é obrigatório')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ error: 'Unauthorized' });
      const { id } = req.params;
      const { user_id, instrument } = req.body;
      const creatorId = req.user.userId;

      const suggestion = await EventJamMusicSuggestion.findOne({ 
        where: { [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }] }
      });

      if (!suggestion) return res.status(404).json({ error: 'Not Found' });

      let isOwner = suggestion.created_by_user_id === creatorId;
      if (!isOwner && suggestion.created_by_guest_id) {
         let guest = await EventGuest.findOne({ where: { user_id: creatorId, event_id: suggestion.event_id } });
         
         if (!guest) {
             const user = await User.findByPk(creatorId);
             if (user && user.email) {
                 guest = await EventGuest.findOne({ where: { guest_email: user.email, event_id: suggestion.event_id } });
                 if (guest && !guest.user_id) {
                     await guest.update({ user_id: creatorId });
                 }
             }
         }

         if (guest && guest.id === suggestion.created_by_guest_id) isOwner = true;
      }

      if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
      if (suggestion.status !== 'DRAFT') return res.status(400).json({ error: 'Sugestão não está em rascunho' });

      const guestUser = await User.findOne({ where: { id_code: user_id } });
      if (!guestUser) return res.status(404).json({ error: 'Usuário convidado não encontrado' });

      // Verificar se já existe
      const existing = await EventJamMusicSuggestionParticipant.findOne({
        where: { music_suggestion_id: suggestion.id, user_id: guestUser.id }
      });

      if (existing) return res.status(400).json({ error: 'Usuário já está na lista' });

      // Tenta achar o guest do convidado
      const invitedGuest = await EventGuest.findOne({ where: { event_id: suggestion.event_id, user_id: guestUser.id } });

      const participant = await EventJamMusicSuggestionParticipant.create({
        music_suggestion_id: suggestion.id,
        user_id: guestUser.id,
        guest_id: invitedGuest ? invitedGuest.id : null,
        instrument,
        is_creator: false,
        status: 'PENDING'
      });

      return res.status(201).json({ success: true, data: participant });

    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * 3.1 Remover Participante
 * DELETE /api/v1/music-suggestions/:id/participants/:targetUserId
 * Note: participantId pode ser o ID do participante (PK) ou UUID do user.
 * Vamos assumir que recebemos o UUID do USUÁRIO para remover o convite dele.
 */
router.delete('/:id/participants/:targetUserId', optionalAuth, async (req, res) => {
  try {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { id, targetUserId } = req.params;
    const creatorId = req.user.userId;

    const suggestion = await EventJamMusicSuggestion.findOne({ 
      where: { [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }] }
    });

    if (!suggestion) return res.status(404).json({ error: 'Not Found' });

    let isOwner = suggestion.created_by_user_id === creatorId;
    if (!isOwner && suggestion.created_by_guest_id) {
       let guest = await EventGuest.findOne({ where: { user_id: creatorId, event_id: suggestion.event_id } });
       
       if (!guest) {
           const user = await User.findByPk(creatorId);
           if (user && user.email) {
               guest = await EventGuest.findOne({ where: { guest_email: user.email, event_id: suggestion.event_id } });
               if (guest && !guest.user_id) {
                   await guest.update({ user_id: creatorId });
               }
           }
       }

       if (guest && guest.id === suggestion.created_by_guest_id) isOwner = true;
    }

    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    // Buscar ID do user alvo
    const targetUser = await User.findOne({ where: { id_code: targetUserId } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const deleted = await EventJamMusicSuggestionParticipant.destroy({
      where: {
        music_suggestion_id: suggestion.id,
        user_id: targetUser.id,
        is_creator: false // Não pode se auto-remover por essa rota (ou criador não sai)
      }
    });

    if (!deleted) return res.status(404).json({ error: 'Participante não encontrado nesta sugestão' });

    return res.json({ success: true, message: 'Participante removido' });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * 4. Ações do Convidado (Aceitar/Recusar)
 * PATCH /api/v1/music-suggestions/:id/participants/me/status
 */
router.patch('/:id/participants/me/status', 
  optionalAuth, 
  [
    body('status').isIn(['ACCEPTED', 'REJECTED']).withMessage('Status inválido')
  ],
  async (req, res) => {
    try {
      // 1. Validar Token/Usuário
      if (!req.user || !req.user.userId) {
         return res.status(401).json({ error: 'Unauthorized', message: 'Token inválido ou expirado. Faça login novamente.' });
      }

      const { id } = req.params;
      const { status } = req.body;
      const userId = req.user.userId;

      const suggestion = await EventJamMusicSuggestion.findOne({ 
        where: { [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }] }
      });

      if (!suggestion) return res.status(404).json({ error: 'Not Found' });

      // Tenta achar o participante pelo user_id
      // Se não achar, tenta achar pelo guest vinculado ao user
      let participant = await EventJamMusicSuggestionParticipant.findOne({
        where: { music_suggestion_id: suggestion.id, user_id: userId }
      });

      if (!participant) {
         // Tenta pelo guest
         const guest = await EventGuest.findOne({ where: { user_id: userId, event_id: suggestion.event_id } });
         if (guest) {
            participant = await EventJamMusicSuggestionParticipant.findOne({
               where: { music_suggestion_id: suggestion.id, guest_id: guest.id }
            });
            
            // Se achou pelo guest, aproveita e vincula o user_id para facilitar o futuro
            if (participant && !participant.user_id) {
               await participant.update({ user_id: userId });
            }
         }
      }

      if (!participant) return res.status(403).json({ error: 'Você não é um participante desta sugestão' });

      participant.status = status;
      await participant.save();
      // clearSuggestionsCache(suggestion.event_id_code || id); // Precisa do ID do evento para limpar cache correto? 
      // A função clearSuggestionsCache espera event_id (UUID ou ID?)
      // Vou limpar de forma segura se tiver o event_id
      if (suggestion.event_id) {
         // Buscar UUID do evento se precisar, ou limpar tudo
         // Mas clearSuggestionsCache espera UUID. Vamos buscar o evento.
         const event = await Event.findByPk(suggestion.event_id);
         if (event) clearSuggestionsCache(event.id_code);
      }

      return res.json({ success: true, data: participant });

    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * 5. Aprovação do Admin (Transformar em Jam Song)
 * POST /api/v1/music-suggestions/:id/approve
 */
router.post('/:id/approve',
  authenticateToken,
  requireModule('events'),
  [
    body('jam_id').optional().isString().withMessage('Jam ID deve ser string (UUID)'),
    body('target_jam_slug').optional().isString(), // Alternativa se quiser buscar por slug
  ],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { jam_id, target_jam_slug } = req.body;
      const adminId = req.user.userId;

      // Verificar permissão de admin/master
      if (!['admin', 'master'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden', message: 'Apenas administradores podem aprovar sugestões' });
      }

      const suggestion = await EventJamMusicSuggestion.findOne({ 
        where: { 
          [Op.or]: [{ id_code: id }, { id: isNaN(id) ? 0 : id }]
        },
        include: [{ model: EventJamMusicSuggestionParticipant, as: 'participants' }]
      });

      if (!suggestion) return res.status(404).json({ error: 'Not Found', message: 'Sugestão não encontrada' });

      // Se for admin/master, permite aprovar mesmo que não esteja em SUBMITTED (ex: DRAFT)
      // Isso facilita testes e permite que o admin crie a sugestão e aprove direto
      if (suggestion.status !== 'SUBMITTED' && !['admin', 'master'].includes(req.user.role)) {
        return res.status(400).json({ error: 'Bad Request', message: 'Apenas sugestões submetidas podem ser aprovadas' });
      }

      // Buscar a Jam (tenta por id_code UUID ou ID numérico)
      let targetJam = null;
      if (jam_id) {
        targetJam = await EventJam.findOne({ 
          where: { 
            [Op.or]: [
              { id_code: jam_id },
              // Se jam_id for numérico, também tenta buscar por ID
              ...(!isNaN(jam_id) ? [{ id: jam_id }] : [])
            ]
          }
        });
      } else if (target_jam_slug) {
        targetJam = await EventJam.findOne({ where: { slug: target_jam_slug } });
      }

      if (!targetJam) {
        return res.status(404).json({ error: 'Not Found', message: 'Jam não encontrada' });
      }

      // Iniciar transação para criar tudo
      const transaction = await EventJamMusicSuggestion.sequelize.transaction();

      try {
        const { instrument_slots, pre_approved_candidates } = req.body;

        // 1. Criar a música (EventJamSong)
        const newSong = await EventJamSong.create({
          jam_id: targetJam.id,
          title: suggestion.song_name,
          artist: suggestion.artist_name,
          cover_image: suggestion.cover_image,
          extra_data: suggestion.extra_data,
          catalog_id: suggestion.catalog_id, // Herda o ID do catálogo
          status: 'planned', // Vai para a coluna 'planned'
          ready: false,
          order_index: 999 // Final da fila
        }, { transaction });

        // Increment usage count for catalog item
        if (suggestion.catalog_id) {
          try {
            await EventJamMusicCatalog.increment('usage_count', { where: { id: suggestion.catalog_id }, transaction });
          } catch (e) {
            console.error('Erro ao incrementar usage_count:', e);
          }
        }

        // 2. Processar Instrument Slots e Candidatos
        // Se o frontend enviou estrutura personalizada (instrument_slots), usa ela (Override)
        // Caso contrário, usa a lógica padrão baseada nos participantes da sugestão

        const shouldUseCustomStructure = Array.isArray(instrument_slots) && instrument_slots.length > 0;

        if (shouldUseCustomStructure) {
          // Lógica de Override (Custom Structure)
          for (const s of instrument_slots) {
            await EventJamSongInstrumentSlot.create({ 
              jam_song_id: newSong.id, 
              instrument: s.instrument, 
              slots: s.slots || 1, 
              required: s.required !== undefined ? !!s.required : true, 
              fallback_allowed: s.fallback_allowed !== undefined ? !!s.fallback_allowed : true 
            }, { transaction });
          }

          if (Array.isArray(pre_approved_candidates) && pre_approved_candidates.length) {
            for (const candidate of pre_approved_candidates) {
              if (!candidate.user_id || !candidate.instrument) continue;
              
              const userIdClean = String(candidate.user_id).trim();
              
              // Validate UUID format to prevent enumeration attacks
              const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
              if (!uuidRegex.test(userIdClean)) {
                  console.warn(`[Approve] Invalid UUID format for User ID: ${userIdClean}`);
                  // We throw an error to rollback transaction and inform the frontend
                  throw new Error(`ID do usuário inválido: ${userIdClean}. Esperado UUID.`);
              }

              // Only find by id_code (UUID)
              const user = await User.findOne({ where: { id_code: userIdClean }, transaction });

              if (!user) {
                  console.warn(`[Approve] User not found for ID: ${userIdClean}`);
                  // Decide if we should fail hard or just skip. 
                  // If frontend sends an ID that doesn't exist, it's an error state.
                  throw new Error(`Usuário não encontrado: ${userIdClean}`);
              }

              const eventId = targetJam.event_id;
              const guest = await EventGuest.findOne({ where: { event_id: eventId, user_id: user.id }, transaction });
              
              if (guest) {
                 await EventJamSongCandidate.create({
                   jam_song_id: newSong.id,
                   instrument: candidate.instrument,
                   event_guest_id: guest.id,
                   status: 'approved',
                   approved_at: new Date(),
                   approved_by_user_id: adminId
                 }, { transaction });
              } else {
                 console.warn(`[Approve] Guest not found for User: ${userIdClean} in Event: ${eventId}`);
                 // Should we fail if guest is not checked in? Probably yes for data integrity.
                 throw new Error(`Usuário ${user.name} não está vinculado como convidado neste evento.`);
              }
            }
          }

        } else {
          // Lógica Padrão (Baseada nos participantes da Sugestão)
          // Agrupar participantes por instrumento para saber quantos slots criar
          const participantsByInstrument = {};
          for (const p of suggestion.participants) {
            if (!participantsByInstrument[p.instrument]) {
              participantsByInstrument[p.instrument] = [];
            }
            participantsByInstrument[p.instrument].push(p);
          }

          for (const [instrument, participants] of Object.entries(participantsByInstrument)) {
            // Criar Slot para esse instrumento
            // Quantidade de slots = quantidade de participantes aceitos
            const approvedParticipants = participants.filter(p => p.status === 'ACCEPTED');
            
            if (approvedParticipants.length > 0) {
              await EventJamSongInstrumentSlot.create({
                jam_song_id: newSong.id,
                instrument: instrument,
                slots: approvedParticipants.length,
                required: true,
                fallback_allowed: true
              }, { transaction });

              // Criar Candidatos (EventJamSongCandidate)
              for (const p of approvedParticipants) {
                const eventId = targetJam.event_id;
                const guest = await EventGuest.findOne({
                  where: { event_id: eventId, user_id: p.user_id },
                  transaction // IMPORTANTE: Passar transaction
                });

                if (guest) {
                  await EventJamSongCandidate.create({
                    jam_song_id: newSong.id,
                    instrument: instrument,
                    event_guest_id: guest.id,
                    status: 'approved',
                    applied_at: new Date(),
                    approved_at: new Date(),
                    approved_by_user_id: adminId
                  }, { transaction });
                } else {
                  console.warn(`EventGuest não encontrado para usuário ${p.user_id} no evento ${eventId}`);
                }
              }
            }
          }
        }

        // 3. Atualizar status da sugestão
        suggestion.status = 'APPROVED';
        await suggestion.save({ transaction });

        await transaction.commit();

        // IMPORTANTE: Invalida o cache do Kanban (Jams) e de Sugestões
        // Agora que o cache é centralizado, podemos limpar de qualquer rota!
        const eventIdCode = suggestion.event_id_code || targetJam.event_id_code;
        if (eventIdCode) {
          clearJamsCache(eventIdCode);
          clearSuggestionsCache(eventIdCode);
        }

        return res.json({ 
          success: true, 
          message: 'Sugestão aprovada e adicionada à Jam!',
          data: {
            suggestion_id: suggestion.id,
            jam_song_id: newSong.id,
            jam_id: targetJam.id
          }
        });

      } catch (err) {
        await transaction.rollback();
        throw err;
      }

    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
);

module.exports = router;
