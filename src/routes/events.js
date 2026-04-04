const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireRole, requireModule } = require('../middlewares/auth');
const { sequelize } = require('../config/database');
const { Op, fn, col } = require('sequelize');
const { Event, EventQuestion, EventResponse, EventAnswer, User, EventGuest, TokenBlocklist, EventTicketType, EventTicket } = require('../models');
const jwt = require('jsonwebtoken');
const { incrementMetric } = require('../utils/requestContext');
const { verifyEventTicketQrToken } = require('../utils/eventTicketQr');

const router = express.Router();

// Helper para sanitizar evento (ocultar ID numérico e usar UUID)
const sanitizeEvent = (event) => {
  if (!event) return null;
  const json = event.toJSON ? event.toJSON() : event;
  // Se tiver id_code, usa como id
  if (json.id_code) {
    json.id = json.id_code;
    // delete json.id_code; // Opcional: manter id_code redundante ou remover? 
    // Por compatibilidade com outros módulos que podem esperar id_code explícito, vamos manter ambos ou apenas id?
    // O padrão "moderno" da API parece ser: id = uuid.
  }
  // Remove ID numérico se ainda existir (caso id_code não tenha sobrescrito ou seja diferente)
  // Mas como id_code é string e id é int, a atribuição acima sobrescreve.
  return json;
};

// Helper para detalhar erros de duplicidade (unique constraint)
function formatDuplicateError(error) {
  const sqlMessage = error?.parent?.sqlMessage || '';
  let field = null;
  if (sqlMessage.includes('uniq_event_email_guest')) field = 'guest_email';
  else if (sqlMessage.includes('uniq_event_document_guest')) field = 'guest_document_number';
  else if (sqlMessage.includes('uniq_event_user_guest')) field = 'user_id';
  else if (Array.isArray(error?.errors) && error.errors.length) {
    field = error.errors[0].path || error.errors[0].column || null;
  }

  let message;
  switch (field) {
    case 'guest_email':
      message = 'Email já está em uso neste evento';
      break;
    case 'guest_document_number':
      message = 'Documento já está em uso neste evento';
      break;
    case 'user_id':
      message = 'Usuário já está associado a este evento';
      break;
    default:
      message = 'Convidado duplicado por email/documento/usuário';
  }

  const details = field ? [{ field, issue: 'duplicate' }] : [];
  return { error: 'Duplicate entry', message, details };
}

/**
 * @swagger
 * /api/v1/events:
 *   post:
 *     summary: Criar evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug, description, start_datetime, end_datetime, place]
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               banner_url:
 *                 type: string
 *               card_background_type:
 *                 type: integer
 *                 enum: [0, 1]
 *                 description: "Preferência de fundo do cartão: 0=cores (degradê), 1=imagem"
 *               auto_checkin:
 *                 type: boolean
 *                 description: "Quando verdadeiro, o fluxo solicita auto check-in antes das perguntas"
 *               description:
 *                 type: string
 *               public_url:
 *                 type: string
 *               gallery_url:
 *                 type: string
 *               place:
 *                 type: string
 *               resp_email:
 *                 type: string
 *                 format: email
 *               resp_name:
 *                 type: string
 *               resp_phone:
 *                 type: string
 *               color_1:
 *                 type: string
 *               color_2:
 *                 type: string
 *               card_background:
 *                 type: string
 *               start_datetime:
 *                 type: string
 *                 format: date-time
 *               end_datetime:
 *                 type: string
 *                 format: date-time
 *               questions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     text:
 *                       type: string
 *                     type:
 *                       type: string
*                       enum: [text, textarea, radio, checkbox, rating, music_preference, auto_checkin]
 *                     options:
 *                       type: array
 *                       items:
 *                         oneOf:
 *                           - type: string
 *                           - type: object
 *                             properties:
 *                               label:
 *                                 type: string
 *                               is_correct:
 *                                 type: boolean
 *                             required: [label]
 *                     max_choices:
 *                       type: integer
 *                       description: Limite de seleções (apenas para checkbox)
 *                     correct_option_index:
 *                       type: integer
 *                       description: Índice da opção correta (apenas para radio)
 *                     is_public:
 *                       type: boolean
 *                     is_required:
 *                       type: boolean
 *                     show_results:
 *                       type: boolean
 *           example:
 *             name: "BeerClub Fest"
 *             slug: "beerclub-fest-2025"
 *             description: "Degustação e votação de estilos"
 *             start_datetime: "2025-11-20T18:00:00Z"
 *             end_datetime: "2025-11-20T21:00:00Z"
 *             place: "Taproom Central"
 *             questions:
 *               - text: "Qual estilo você prefere?"
 *                 type: "radio"
 *                 options:
 *                   - { label: "Lager" }
 *                   - { label: "IPA", is_correct: true }
 *                   - { label: "Stout" }
 *                 is_public: true
 *                 show_results: true
 *               - text: "Quais maltes você escolhe?"
 *                 type: "checkbox"
 *                 options:
 *                   - { label: "Pils" }
 *                   - { label: "Cara" }
 *                   - { label: "Munich" }
 *                 max_choices: 2
 *                 is_public: true
 *                 show_results: true
 *     responses:
 *       201:
 *         description: Evento criado com sucesso
 */
// POST /api/v1/events - Cria evento + perguntas
router.post('/', authenticateToken, requireRole('admin', 'master'), requireModule('events'), [
  body('name').isLength({ min: 2 }).withMessage('Nome é obrigatório.'),
  body('slug').isLength({ min: 2 }).withMessage('Slug é obrigatório.'),
  body('banner_url').optional().isURL({ require_tld: false }).withMessage('banner_url inválida'),
  body('description').isLength({ min: 1 }).withMessage('Descrição é obrigatória.'),
  body('public_url').optional().isURL({ require_tld: false }).withMessage('public_url inválida'),
  body('gallery_url').optional().isURL({ require_tld: false }).withMessage('gallery_url inválida'),
  body('place').isLength({ min: 2 }).withMessage('Local é obrigatório.'),
  body('resp_email').optional().isEmail().withMessage('resp_email inválido'),
  body('resp_name').optional().isString(),
  body('resp_phone').optional().isString(),
  body('color_1').optional().isString(),
  body('color_2').optional().isString(),
  body('card_background').optional().isString(),
  body('card_background_type').optional().isInt({ min: 0, max: 1 }),
  body('start_datetime').isISO8601().withMessage('start_datetime é obrigatório e deve ser uma data válida.'),
  body('end_datetime').isISO8601().withMessage('end_datetime é obrigatório e deve ser uma data válida.'),
  body('auto_checkin').optional().isBoolean(),
  body('requires_auto_checkin').optional().isBoolean(),
  body('auto_checkin_flow_quest').optional().isBoolean(),
  body('checkin_component_config').optional(),
  body('questions').optional().isArray()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  const {
    name,
    slug,
    banner_url,
    start_datetime,
    end_datetime,
    description,
    public_url,
    gallery_url,
    place,
    resp_email,
    resp_name,
    resp_phone,
    color_1,
    color_2,
    card_background,
    card_background_type,
    auto_checkin,
    requires_auto_checkin,
    auto_checkin_flow_quest,
    checkin_component_config,
    questions = []
  } = req.body;
  const creatorId = req.user.userId;

  try {
    const normalizeLocalIso = (value) => {
      if (!value) return null;
      if (typeof value === 'string') {
        const parts = value.split('T');
        if (parts.length < 2) return null;
        const datePart = parts[0];
        const timePart = String(parts[1]).substring(0, 5);
        if (!datePart || timePart.length < 4) return null;
        return `${datePart}T${timePart}`;
      }
      if (value instanceof Date && !isNaN(value.getTime())) {
        const pad2 = (n) => String(n).padStart(2, '0');
        const datePart = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
        const timePart = `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
        return `${datePart}T${timePart}`;
      }
      return null;
    };

    // Slug único
    const existing = await Event.findOne({ where: { slug } });
    if (existing) {
      return res.status(409).json({ error: 'Duplicate entry', message: 'Slug já existe' });
    }

    // Validação de ordem das datas: end_datetime não pode ser anterior a start_datetime
    const startNorm = normalizeLocalIso(start_datetime);
    const endNorm = normalizeLocalIso(end_datetime);
    if (startNorm && endNorm) {
      if (endNorm < startNorm) {
        return res.status(400).json({ error: 'Validation error', message: 'end_datetime não pode ser anterior a start_datetime' });
      }
    }

    if (!startNorm) {
      return res.status(400).json({ error: 'Validation error', message: 'start_datetime inválido ou ausente' });
    }

    if (!endNorm) {
      return res.status(400).json({ error: 'Validation error', message: 'end_datetime inválido ou ausente' });
    }

    const startParts = startNorm.split('T');
    const endParts = endNorm.split('T');

    const date = startParts[0];
    const end_date = endParts[0];
    const start_time_val = startParts[1];
    const end_time_val = endParts[1];

    const t = await sequelize.transaction();
    try {
      // Inferência de preferência se não enviada: imagem quando há card_background, cores quando houver color_1/color_2
      const inferredType = (card_background_type !== undefined)
        ? card_background_type
        : (card_background ? 1 : ((color_1 || color_2) ? 0 : null));

      const event = await Event.create({
        name,
        slug,
        banner_url,
        date,
        end_date,
        start_time: start_time_val,
        end_time: end_time_val,
        description,
        public_url,
        gallery_url,
        place,
        resp_email,
        resp_name,
        resp_phone,
        color_1,
        color_2,
        card_background,
        card_background_type: inferredType,
        auto_checkin: !!auto_checkin,
        requires_auto_checkin: !!requires_auto_checkin,
        auto_checkin_flow_quest: !!auto_checkin_flow_quest,
        checkin_component_config: checkin_component_config || null,
        created_by: creatorId
      }, { transaction: t });

      // Criar perguntas, se houver
      if (Array.isArray(questions) && questions.length) {
        const payload = [];
        for (let idx = 0; idx < questions.length; idx++) {
          const q = questions[idx];
          const type = q.type || 'text';
          const rawOptions = Array.isArray(q.options) ? q.options : (q.options || null);
          const labels = Array.isArray(rawOptions) ? rawOptions.map(o => (typeof o === 'string') ? o : (o && o.label)).filter(v => typeof v === 'string') : [];
          let correctIndex = null;
          let maxChoices = null;

          if (type === 'radio') {
            if (q.correct_option_index !== undefined) {
              const idxVal = parseInt(q.correct_option_index, 10);
              if (!Array.isArray(rawOptions) || idxVal < 0 || idxVal >= labels.length) {
                await t.rollback();
                return res.status(400).json({ error: 'Validation error', message: `correct_option_index fora do intervalo de options na pergunta ${idx}` });
              }
              correctIndex = idxVal;
            } else if (Array.isArray(rawOptions)) {
              const markers = rawOptions.filter(o => o && typeof o === 'object' && o.is_correct === true);
              if (markers.length > 1) {
                await t.rollback();
                return res.status(400).json({ error: 'Validation error', message: `Apenas uma opção pode ser marcada como is_correct na pergunta ${idx}` });
              }
              if (markers.length === 1) {
                const mIdx = rawOptions.findIndex(o => o && typeof o === 'object' && o.is_correct === true);
                if (mIdx < 0 || mIdx >= labels.length) {
                  await t.rollback();
                  return res.status(400).json({ error: 'Validation error', message: `Opção correta inválida na pergunta ${idx}` });
                }
                correctIndex = mIdx;
              }
            }
            if (labels.length === 0 && correctIndex !== null) {
              await t.rollback();
              return res.status(400).json({ error: 'Validation error', message: `Não é possível definir correct_option_index sem options na pergunta ${idx}` });
            }
          }

          if (type === 'checkbox' && q.max_choices !== undefined) {
            const mc = parseInt(q.max_choices, 10);
            if (!(mc >= 1)) {
              await t.rollback();
              return res.status(400).json({ error: 'Validation error', message: `max_choices deve ser >= 1 na pergunta ${idx}` });
            }
            maxChoices = mc;
          }

          // Build choice_config JSON
          const config = {};
          if (rawOptions) config.options = rawOptions;
          if (maxChoices !== null) config.max_choices = maxChoices;
          if (correctIndex !== null) config.correct_option_index = correctIndex;
          if (q.show_results !== undefined) config.show_results = !!q.show_results;

          payload.push({
            event_id: event.id,
            question: q.text,
            type: type,
            choice_config: Object.keys(config).length ? config : null,
            required: q.is_required !== undefined ? !!q.is_required : true,
            is_public: q.is_public !== undefined ? !!q.is_public : true,
            auto_checkin: type === 'auto_checkin',
            order_index: idx
          });
        }
        await EventQuestion.bulkCreate(payload, { transaction: t });
      }

      await t.commit();

      const created = await Event.findByPk(event.id, {
        include: [{ model: EventQuestion, as: 'questions', order: [['order_index', 'ASC']] }]
      });

      return res.status(201).json({ success: true, data: { event: sanitizeEvent(created) } });
    } catch (err) {
      await t.rollback();
      throw err;
    }
  } catch (error) {
    console.error('Create event error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

 

/**
 * @swagger
 * /api/v1/events:
 *   get:
 *     summary: Listar eventos (admin/master) com paginação e filtros
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [created_at, start_datetime, end_datetime, name]
 *           default: created_at
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *       - in: query
 *         name: slug
 *         schema:
 *           type: string
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [upcoming, ongoing, past]
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Lista paginada de eventos
 */
// GET /api/v1/events - Lista eventos do admin (ou todos se master) com paginação/filtros
router.get('/', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const isMaster = req.user.role === 'master';

    // Query params
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const sortByAllowed = ['created_at', 'start_datetime', 'end_datetime', 'name'];
    const sortBy = sortByAllowed.includes(req.query.sort_by) ? req.query.sort_by : 'created_at';
    const { name, slug, status, from, to } = req.query;
    const createdBy = req.query.created_by ? parseInt(req.query.created_by, 10) : undefined;

    const where = {};
    if (!isMaster) {
      where.created_by = req.user.userId;
    } else if (createdBy) {
      where.created_by = createdBy;
    }
    if (name) {
      where.name = { [Op.like]: `%${name}%` };
    }
    if (slug) {
      where.slug = { [Op.like]: `%${slug}%` };
    }
    if (from || to) {
      // Filtra por intervalo do início do evento
      where.date = {};
      if (from) where.date[Op.gte] = from;
      if (to) where.date[Op.lte] = to;
    }
    if (status) {
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      const currentTime = now.toTimeString().split(' ')[0];

      if (status === 'upcoming') {
        where[Op.and] = (where[Op.and] || []).concat([{
          [Op.or]: [
            { date: { [Op.gt]: today } },
            { date: today, [Op.or]: [{ start_time: null }, { start_time: { [Op.gt]: currentTime } }] }
          ]
        }]);
      } else if (status === 'past') {
        where[Op.and] = (where[Op.and] || []).concat([{
          [Op.or]: [
            { end_date: { [Op.lt]: today } },
            { end_date: null, date: { [Op.lt]: today } },
            { end_date: null, date: today, end_time: { [Op.lt]: currentTime } },
            { end_date: today, end_time: { [Op.lt]: currentTime } }
          ]
        }]);
      } else if (status === 'ongoing') {
        where[Op.and] = (where[Op.and] || []).concat([
          {
            [Op.or]: [
              { date: { [Op.lt]: today } },
              { date: today, start_time: { [Op.lte]: currentTime } }
            ]
          },
          {
            [Op.or]: [
              { end_date: { [Op.gt]: today } },
              { end_date: null, date: today, [Op.or]: [{ end_time: null }, { end_time: { [Op.gte]: currentTime } }] },
              { end_date: today, [Op.or]: [{ end_time: null }, { end_time: { [Op.gte]: currentTime } }] }
            ]
          }
        ]);
      }
    }

    const offset = (page - 1) * limit;

    // Contagem total
    const total = await Event.count({ where });

    // Consulta paginada com coluna derivada de quantidade de perguntas via subquery
    const rows = await Event.findAll({
      where,
      attributes: [
        'id_code', 'name', 'slug', 'description', 'banner_url', 'date', 'end_date', 'start_time', 'end_time', 'created_at', 'status',
        [sequelize.literal('(SELECT COUNT(*) FROM event_questions AS eq WHERE eq.event_id = "Event"."id")'), 'questions_count']
      ],
      order: [[sortBy, order]],
      offset,
      limit
    });

    return res.json({
      success: true,
      data: { 
        events: rows.map(r => {
           // Mapeia para manter compatibilidade com frontend se necessário
           const ev = r.toJSON();
           ev.start_datetime = ev.date && ev.start_time ? `${ev.date}T${ev.start_time}` : null;
           const endDate = ev.end_date || ev.date;
           ev.end_datetime = endDate && ev.end_time ? `${endDate}T${ev.end_time}` : null;
           return sanitizeEvent(ev);
        }) 
      },
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('List events error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}:
 *   get:
 *     summary: Obter detalhes do evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     responses:
 *       200:
 *         description: Dados do evento e total de respostas
 *       404:
 *         description: Evento não encontrado
 */
// Simple in-memory cache for event details to reduce DB pressure
const EVENT_DETAIL_CACHE_TTL = 30000; // 30 seconds for easier dev testing
const eventDetailCache = new Map();

// GET /api/v1/events/:id - Detalhes do evento + perguntas ordenadas + total_responses
router.get('/:id', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `detail-${id}`;

    // Check cache
    const cached = eventDetailCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < EVENT_DETAIL_CACHE_TTL)) {
      if (process.env.NODE_ENV === 'development') console.log(`[EventCache] HIT! Key: ${cacheKey}`);
      incrementMetric('cacheHits');
      const globalMetrics = req.app.get('metrics');
      if (globalMetrics) globalMetrics.cacheHits++;
      return res.json(cached.data);
    } else {
      if (process.env.NODE_ENV === 'development') console.log(`[EventCache] MISS. Key: ${cacheKey}`);
    }

    const event = await Event.findOne({
      where: { id_code: id },
      include: [{
        model: EventQuestion,
        as: 'questions',
        order: [['order_index', 'ASC']]
      }]
    });

    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }

    // Controle de acesso: admin só vê seus eventos
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const total_responses = await EventResponse.count({ where: { event_id: event.id } });

    const responseData = { success: true, data: { event: sanitizeEvent(event), total_responses } };

    // Save to cache
    eventDetailCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now()
    });
    if (process.env.NODE_ENV === 'development') console.log(`[EventCache] SAVED! Key: ${cacheKey}`);

    return res.json(responseData);
  } catch (error) {
    console.error('Get event error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}:
 *   patch:
 *     summary: Atualizar parcialmente evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               slug:
 *                 type: string
 *               banner_url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Evento atualizado com sucesso
 *       404:
 *         description: Evento não encontrado
 *       409:
 *         description: Slug já existe
 */
// PATCH /api/v1/events/:id - Atualiza apenas campos enviados, valida slug único
router.patch('/:id', authenticateToken, requireRole('admin', 'master'), requireModule('events'), [
  body('name').optional().isLength({ min: 2 }),
  body('slug').optional().isLength({ min: 2 }),
  body('banner_url').optional().isURL({ require_tld: false }).withMessage('banner_url inválida'),
  body('description').optional().isString(),
  body('public_url').optional().isURL({ require_tld: false }).withMessage('public_url inválida'),
  body('gallery_url').optional().isURL({ require_tld: false }).withMessage('gallery_url inválida'),
  body('place').optional().isString(),
  body('resp_email').optional().isEmail().withMessage('resp_email inválido'),
  body('resp_name').optional().isString(),
  body('resp_phone').optional().isString(),
  body('color_1').optional().isString(),
  body('color_2').optional().isString(),
  body('card_background').optional().isString(),
  body('card_background_type').optional().isInt({ min: 0, max: 1 }),
  body('start_datetime').optional().isISO8601().withMessage('start_datetime deve ser uma data válida'),
  body('end_datetime').optional().isISO8601().withMessage('end_datetime deve ser uma data válida'),
  body('auto_checkin').optional().isBoolean(),
  body('requires_auto_checkin').optional().isBoolean(),
  body('auto_checkin_flow_quest').optional().isBoolean(),
  body('checkin_component_config').optional(),
  body('status').optional().isIn(['draft', 'published', 'canceled', 'paused', 'finished']).withMessage('Status inválido')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }

    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const allowed = ['name', 'slug', 'banner_url', 'description', 'public_url', 'gallery_url', 'place', 'resp_email', 'resp_name', 'resp_phone', 'color_1', 'color_2', 'card_background', 'card_background_type', 'start_datetime', 'end_datetime', 'auto_checkin', 'requires_auto_checkin', 'auto_checkin_flow_quest', 'checkin_component_config', 'status'];
    const updateData = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updateData[key] = req.body[key];
    }

    if (updateData.slug && updateData.slug !== event.slug) {
      const exists = await Event.findOne({ where: { slug: updateData.slug, id: { [Op.ne]: event.id } } });
      if (exists) {
        return res.status(409).json({ error: 'Duplicate entry', message: 'Slug já existe' });
      }
    }

    // Validação de ordem das datas no PATCH: calcula valores finais e compara
    const normalizeLocalIso = (value) => {
      if (!value) return null;
      if (typeof value === 'string') {
        const parts = value.split('T');
        if (parts.length < 2) return null;
        const datePart = parts[0];
        const timePart = String(parts[1]).substring(0, 5);
        if (!datePart || timePart.length < 4) return null;
        return `${datePart}T${timePart}`;
      }
      if (value instanceof Date && !isNaN(value.getTime())) {
        const pad2 = (n) => String(n).padStart(2, '0');
        const datePart = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
        const timePart = `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;
        return `${datePart}T${timePart}`;
      }
      return null;
    };

    const baseStart = event.date && event.start_time ? `${event.date}T${String(event.start_time).substring(0, 5)}` : null;
    const baseEndDate = event.end_date || event.date;
    const baseEnd = baseEndDate && event.end_time ? `${baseEndDate}T${String(event.end_time).substring(0, 5)}` : null;

    const newStart = updateData.start_datetime !== undefined ? normalizeLocalIso(updateData.start_datetime) : baseStart;
    const newEnd = updateData.end_datetime !== undefined ? normalizeLocalIso(updateData.end_datetime) : baseEnd;

    if (newStart && newEnd) {
      if (newEnd < newStart) {
        return res.status(400).json({ error: 'Validation error', message: 'end_datetime não pode ser anterior a start_datetime' });
      }
    }

    // Se não enviar explicitamente o tipo, mas alterar os campos de fundo, re-inferir
    if (updateData.card_background_type === undefined && (updateData.card_background !== undefined || updateData.color_1 !== undefined || updateData.color_2 !== undefined)) {
      const finalCardBackground = updateData.card_background !== undefined ? updateData.card_background : event.card_background;
      const finalColor1 = updateData.color_1 !== undefined ? updateData.color_1 : event.color_1;
      const finalColor2 = updateData.color_2 !== undefined ? updateData.color_2 : event.color_2;
      updateData.card_background_type = finalCardBackground ? 1 : ((finalColor1 || finalColor2) ? 0 : null);
    }

    // Process dates for Postgres (DATE + TIME fields) preserving local input
    if (updateData.start_datetime) {
      const norm = normalizeLocalIso(updateData.start_datetime);
      if (norm) {
        const parts = norm.split('T');
        updateData.date = parts[0];
        updateData.start_time = parts[1];
      }
      delete updateData.start_datetime;
    }

    if (updateData.end_datetime) {
      const norm = normalizeLocalIso(updateData.end_datetime);
      if (norm) {
        const parts = norm.split('T');
        updateData.end_date = parts[0];
        updateData.end_time = parts[1];
      }
      delete updateData.end_datetime;
    }

    await event.update(updateData);

    const updated = await Event.findByPk(event.id);
    return res.json({ success: true, message: 'Evento atualizado com sucesso', data: { event: sanitizeEvent(updated) } });
  } catch (error) {
    console.error('Patch event error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}:
 *   delete:
 *     summary: Remover evento (soft delete)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     responses:
 *       200:
 *         description: Evento removido (soft delete)
 *       404:
 *         description: Evento não encontrado
 */
// DELETE /api/v1/events/:id - Soft delete com cascata lógica
router.delete('/:id', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      await t.rollback();
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }

    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      await t.rollback();
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    // 1. Marcar como cancelado e fazer Soft Delete
    await event.update({ status: 'canceled' }, { transaction: t });
    await event.destroy({ transaction: t });

    // 2. Cancelar Jams associadas (Cascata Lógica)
    // Isso garante que mesmo se acessadas diretamente, estarão canceladas
    const { EventJam } = require('../models'); // Importar aqui ou garantir que está no topo
    await EventJam.update(
      { status: 'canceled' },
      { where: { event_id: event.id }, transaction: t }
    );

    await t.commit();

    return res.json({ success: true, message: 'Evento excluído e Jams canceladas com sucesso.' });
  } catch (error) {
    await t.rollback();
    console.error('Delete event error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/questions:
 *   get:
 *     summary: Listar perguntas do evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     responses:
 *       200:
 *         description: Lista de perguntas do evento
 *       404:
 *         description: Evento não encontrado
 */
router.get('/:id/questions', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }

    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const questions = await EventQuestion.findAll({ where: { event_id: event.id }, order: [['order_index', 'ASC']] });
    return res.json({ success: true, data: { questions } });
  } catch (error) {
    console.error('List questions error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/questions/{questionId}/stats:
 *   get:
 *     summary: Estatísticas de respostas por opção (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: path
 *         name: questionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Estatísticas agregadas por opção
 *       404:
 *         description: Evento/Pergunta não encontrado
 */
router.get('/:id/questions/:questionId/stats', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  try {
    const { id, questionId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const question = await EventQuestion.findOne({ where: { id: questionId, event_id: event.id } });
    if (!question) {
      return res.status(404).json({ error: 'Not found', message: 'Pergunta não encontrada' });
    }
    if (!['radio', 'checkbox'].includes(question.question_type)) {
      return res.status(400).json({ error: 'Unsupported', message: 'Estatísticas disponíveis apenas para tipos radio/checkbox' });
    }

    // Extrair labels de opções de forma robusta e sanitizar marcador [c]
    let items = [];
    const raw = question.options;
    if (Array.isArray(raw)) items = raw;
    else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) items = parsed;
        else if (parsed && Array.isArray(parsed.options)) items = parsed.options;
        else if (parsed && Array.isArray(parsed.labels)) items = parsed.labels;
      } catch (_) {
        items = [];
      }
    } else if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.options)) items = raw.options;
      else if (Array.isArray(raw.labels)) items = raw.labels;
    }

    const labels = items
      .map(o => (typeof o === 'string') ? o : (o && o.label))
      .filter(v => typeof v === 'string' && v.length > 0)
      .map(v => v.replace(/\s*\[c\]\s*$/i, ''));
    const counts = new Map(labels.map(o => [o, 0]));

    const answers = await EventAnswer.findAll({ where: { question_id: question.id } });
    for (const a of answers) {
      if (question.question_type === 'radio') {
        let sel = undefined;
        if (typeof a.answer_text === 'string' && a.answer_text.length) sel = a.answer_text;
        else if (a.answer_json && typeof a.answer_json === 'object' && typeof a.answer_json.label === 'string') sel = a.answer_json.label;
        else if (typeof a.answer_json === 'string') {
          try {
            const parsed = JSON.parse(a.answer_json);
            if (parsed && typeof parsed === 'object' && typeof parsed.label === 'string') sel = parsed.label;
          } catch (_) {}
        }
        if (typeof sel === 'string') {
          const s = sel.replace(/\s*\[c\]\s*$/i, '');
          if (counts.has(s)) counts.set(s, counts.get(s) + 1);
        }
      } else if (question.question_type === 'checkbox') {
        let arr = [];
        if (Array.isArray(a.answer_json)) arr = a.answer_json;
        else if (typeof a.answer_json === 'string') {
          try {
            const parsed = JSON.parse(a.answer_json);
            if (Array.isArray(parsed)) arr = parsed;
          } catch (_) {}
        }
        if (arr.length === 0 && typeof a.answer_text === 'string') {
          try {
            const parsed = JSON.parse(a.answer_text);
            if (Array.isArray(parsed)) arr = parsed;
          } catch (_) {
            if (a.answer_text.includes(',')) {
              arr = a.answer_text.split(',').map(s => s.trim()).filter(Boolean);
            } else if (a.answer_text.trim().length) {
              arr = [a.answer_text.trim()];
            }
          }
        }
        for (const vRaw of arr) {
          const v = typeof vRaw === 'string' ? vRaw.replace(/\s*\[c\]\s*$/i, '') : vRaw;
          if (typeof v === 'string' && counts.has(v)) {
            counts.set(v, counts.get(v) + 1);
          }
        }
      }
    }

    const total = answers.length;
    const result = labels.map((o, idx) => {
      const c = counts.get(o) || 0;
      return { option: o, index: idx, count: c, percent: total ? Math.round((c / total) * 10000) / 100 : 0 };
    });

    let correct_count = null;
    let accuracy_percent = null;
    if (question.question_type === 'radio' && typeof question.correct_option_index === 'number' && question.correct_option_index >= 0) {
      const correctOption = labels[question.correct_option_index];
      const c = typeof correctOption !== 'undefined' ? (counts.get(correctOption) || 0) : 0;
      correct_count = c;
      accuracy_percent = total ? Math.round((c / total) * 10000) / 100 : 0;
    }

    return res.json({
      success: true,
      data: {
        question_id: question.id,
        type: question.question_type,
        total_answers: total,
        options: labels,
        counts: result,
        correct_option_index: question.correct_option_index ?? null,
        correct_count,
        accuracy_percent
      }
    });
  } catch (error) {
    console.error('Stats question error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/stats:
 *   get:
 *     summary: Estatísticas agregadas do evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     responses:
 *       200:
 *         description: Estatísticas agregadas por pergunta e opções
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 event_id: 42
 *                 total_questions: 3
 *                 event_total_answers: 25
 *                 questions_stats:
 *                   - question_id: 101
 *                     text: Qual estilo você prefere?
 *                     type: radio
 *                     is_public: true
 *                     show_results: true
 *                     total_answers: 10
 *                     options: [Lager, IPA, Stout]
 *                     counts:
 *                       - option: Lager
 *                         index: 0
 *                         count: 3
 *                         percent: 30
 *                       - option: IPA
 *                         index: 1
 *                         count: 5
 *                         percent: 50
 *                       - option: Stout
 *                         index: 2
 *                         count: 2
 *                         percent: 20
 *                     correct_option_index: 1
 *                     correct_count: 5
 *                     accuracy_percent: 50
 *                   - question_id: 102
 *                     text: Quais maltes você escolhe?
 *                     type: checkbox
 *                     is_public: true
 *                     show_results: true
 *                     total_answers: 8
 *                     options: [Pils, Cara, Munich]
 *                     counts:
 *                       - option: Pils
 *                         index: 0
 *                         count: 6
 *                         percent: 75
 *                       - option: Cara
 *                         index: 1
 *                         count: 3
 *                         percent: 37.5
 *                       - option: Munich
 *                         index: 2
 *                         count: 4
 *                         percent: 50
 *       404:
 *         description: Evento não encontrado
 */
router.get('/:id/stats', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const questions = await EventQuestion.findAll({ where: { event_id: event.id }, order: [['order_index', 'ASC']] });
    const questionsStats = [];
    let eventTotalAnswers = 0;

    for (const q of questions) {
      const rawOpts = Array.isArray(q.options) ? q.options : [];
      const labels = rawOpts.map(o => (typeof o === 'string') ? o : (o && o.label)).filter(v => typeof v === 'string');
      const counts = new Map(labels.map(o => [o, 0]));

      const answers = await EventAnswer.findAll({ where: { question_id: q.id } });
      eventTotalAnswers += answers.length;

      if (q.question_type === 'radio') {
        for (const a of answers) {
          if (typeof a.answer_text === 'string' && counts.has(a.answer_text)) {
            counts.set(a.answer_text, counts.get(a.answer_text) + 1);
          }
        }
      } else if (q.question_type === 'checkbox') {
        for (const a of answers) {
          if (Array.isArray(a.answer_json)) {
            for (const v of a.answer_json) {
              if (counts.has(v)) counts.set(v, counts.get(v) + 1);
            }
          }
        }
      } else {
        // Tipos não suportados para contagem por opção; apenas total
      }

      const total = answers.length;
      const optionsCounts = labels.map((o, idx) => {
        const c = counts.get(o) || 0;
        return { option: o, index: idx, count: c, percent: total ? Math.round((c / total) * 10000) / 100 : 0 };
      });

      let correct_count = null;
      let accuracy_percent = null;
      if (q.question_type === 'radio' && typeof q.correct_option_index === 'number' && q.correct_option_index >= 0) {
        const correctOption = labels[q.correct_option_index];
        const c = typeof correctOption !== 'undefined' ? (counts.get(correctOption) || 0) : 0;
        correct_count = c;
        accuracy_percent = total ? Math.round((c / total) * 10000) / 100 : 0;
      }

      questionsStats.push({
        question_id: q.id,
        text: q.question_text,
        type: q.question_type,
        is_public: q.is_public,
        show_results: q.show_results,
        total_answers: total,
        options: labels,
        counts: optionsCounts,
        correct_option_index: q.correct_option_index ?? null,
        correct_count,
        accuracy_percent
      });
    }

    return res.json({
      success: true,
      data: {
        event_id: event.id_code,
        total_questions: questions.length,
        event_total_answers: eventTotalAnswers,
        questions_stats: questionsStats
      }
    });
  } catch (error) {
    console.error('Admin stats event error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/questions:
 *   post:
 *     summary: Criar nova pergunta para o evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text, type]
 *             properties:
 *               text:
 *                 type: string
 *               type:
 *                 type: string
*                 enum: [text, textarea, radio, checkbox, rating, music_preference, auto_checkin]
 *               options:
 *                 type: array
 *                 items:
 *                   oneOf:
 *                     - type: string
 *                     - type: object
 *                       properties:
 *                         label:
 *                           type: string
 *                         is_correct:
 *                           type: boolean
 *                       required: [label]
 *               max_choices:
 *                 type: integer
 *                 description: Limite de seleções (apenas para checkbox)
 *               correct_option_index:
 *                 type: integer
 *                 description: Índice da opção correta (apenas para radio)
 *               is_public:
 *                 type: boolean
 *               is_required:
 *                 type: boolean
 *               show_results:
 *                 type: boolean
 *               order_index:
 *                 type: integer
 *           example:
 *             text: "Qual estilo você prefere?"
 *             type: "radio"
 *             options:
 *               - { label: "Lager" }
 *               - { label: "IPA", is_correct: true }
 *               - { label: "Stout" }
 *             is_public: true
 *             is_required: true
 *             show_results: true
 *             order_index: 0
 *     responses:
 *       201:
 *         description: Pergunta criada com sucesso
 *       404:
 *         description: Evento não encontrado
 */
router.post('/:id/questions', authenticateToken, requireRole('admin', 'master'), requireModule('events'), [
  body('text').isLength({ min: 1 }).withMessage('text é obrigatório'),
  body('type').isIn(['text', 'textarea', 'radio', 'checkbox', 'rating', 'music_preference', 'auto_checkin']).withMessage('type inválido'),
  body('options').optional(),
  body('max_choices').optional().isInt({ min: 1 }).withMessage('max_choices deve ser inteiro >= 1'),
  body('correct_option_index').optional().isInt({ min: 0 }).withMessage('correct_option_index deve ser inteiro >= 0'),
  body('is_required').optional().isBoolean(),
  body('is_public').optional().isBoolean(),
  body('show_results').optional().isBoolean(),
  body('order_index').optional().isInt({ min: 0 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const maxOrder = await EventQuestion.max('order_index', { where: { event_id: event.id } });
    const orderIndex = (req.body.order_index !== undefined) ? parseInt(req.body.order_index, 10) : (Number.isFinite(maxOrder) ? maxOrder + 1 : 0);

    // Validar campos específicos por tipo
    const isRadio = req.body.type === 'radio';
    const isCheckbox = req.body.type === 'checkbox';
    const options = Array.isArray(req.body.options) ? req.body.options : (req.body.options || null);
    const labels = Array.isArray(options) ? options.map(o => (typeof o === 'string') ? o : (o && o.label)).filter(v => typeof v === 'string') : [];
    let correctIndex = null;
    let maxChoices = null;
    if (isRadio) {
      if (req.body.correct_option_index !== undefined) {
        const idx = parseInt(req.body.correct_option_index, 10);
        if (!Array.isArray(options) || idx < 0 || idx >= labels.length) {
          return res.status(400).json({ error: 'Validation error', message: 'correct_option_index fora do intervalo de options' });
        }
        correctIndex = idx;
      } else if (Array.isArray(options)) {
        const markers = options.filter(o => o && typeof o === 'object' && o.is_correct === true);
        if (markers.length > 1) {
          return res.status(400).json({ error: 'Validation error', message: 'Apenas uma opção pode ser marcada como is_correct' });
        }
        if (markers.length === 1) {
          const idx = options.findIndex(o => o && typeof o === 'object' && o.is_correct === true);
          if (idx < 0 || idx >= labels.length) {
            return res.status(400).json({ error: 'Validation error', message: 'Opção correta inválida' });
          }
          correctIndex = idx;
        }
      }
      if (labels.length === 0 && correctIndex !== null) {
        return res.status(400).json({ error: 'Validation error', message: 'Não é possível definir correct_option_index sem opções' });
      }
    }
    if (isCheckbox && req.body.max_choices !== undefined) {
      const mc = parseInt(req.body.max_choices, 10);
      if (!(mc >= 1)) {
        return res.status(400).json({ error: 'Validation error', message: 'max_choices deve ser >= 1' });
      }
      maxChoices = mc;
    }

    // Build choice_config JSON
    const config = {};
    if (options) config.options = options;
    if (maxChoices !== null) config.max_choices = maxChoices;
    if (correctIndex !== null) config.correct_option_index = correctIndex;
    if (req.body.show_results !== undefined) config.show_results = !!req.body.show_results;

    const question = await EventQuestion.create({
      event_id: event.id,
      question: req.body.text,
      type: req.body.type,
      choice_config: Object.keys(config).length ? config : null,
      required: req.body.is_required !== undefined ? !!req.body.is_required : true,
      is_public: req.body.is_public !== undefined ? !!req.body.is_public : true,
      auto_checkin: req.body.type === 'auto_checkin',
      order_index: orderIndex
    });

    return res.status(201).json({ success: true, data: { question } });
  } catch (error) {
    console.error('Create question error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/questions/{questionId}:
 *   patch:
 *     summary: Atualizar pergunta do evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: path
 *         name: questionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text:
 *                 type: string
 *               type:
 *                 type: string
*                 enum: [text, textarea, radio, checkbox, rating, music_preference, auto_checkin]
 *               options:
 *                 type: array
 *                 items:
 *                   oneOf:
 *                     - type: string
 *                     - type: object
 *                       properties:
 *                         label:
 *                           type: string
 *                         is_correct:
 *                           type: boolean
 *                       required: [label]
 *               is_public:
 *                 type: boolean
 *               is_required:
 *                 type: boolean
 *               show_results:
 *                 type: boolean
 *               order_index:
 *                 type: integer
 *           example:
 *             text: "Atualize opções da pergunta"
 *             type: "radio"
 *             options:
 *               - { label: "Lager" }
 *               - { label: "IPA", is_correct: true }
 *               - { label: "Stout" }
 *             correct_option_index: 1
 *             is_public: true
 *             show_results: true
 *             order_index: 1
 *     responses:
 *       200:
 *         description: Pergunta atualizada com sucesso
 *       404:
 *         description: Evento/Pergunta não encontrado
 */
router.patch('/:id/questions/:questionId', authenticateToken, requireRole('admin', 'master'), [
  body('text').optional().isLength({ min: 1 }),
  body('type').optional().isIn(['text', 'textarea', 'radio', 'checkbox', 'rating', 'music_preference', 'auto_checkin']),
  body('options').optional(),
  body('max_choices').optional().isInt({ min: 1 }),
  body('correct_option_index').optional().isInt({ min: 0 }),
  body('is_required').optional().isBoolean(),
  body('is_public').optional().isBoolean(),
  body('show_results').optional().isBoolean(),
  body('order_index').optional().isInt({ min: 0 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    const { id, questionId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const question = await EventQuestion.findOne({ where: { id: questionId, event_id: event.id } });
    if (!question) {
      return res.status(404).json({ error: 'Not found', message: 'Pergunta não encontrada' });
    }

    const allowed = ['question', 'type', 'choice_config', 'required', 'is_public', 'auto_checkin', 'order_index'];
    const updateData = {};
    if (req.body.text !== undefined) updateData.question = req.body.text;
    if (req.body.type !== undefined) {
      updateData.type = req.body.type;
      if (req.body.type === 'auto_checkin') updateData.auto_checkin = true;
    }
    if (req.body.is_required !== undefined) updateData.required = !!req.body.is_required;
    if (req.body.is_public !== undefined) updateData.is_public = !!req.body.is_public;
    if (req.body.order_index !== undefined) updateData.order_index = parseInt(req.body.order_index, 10);

    // Validações coerentes com tipo/opções
    const effectiveType = updateData.type || question.type;
    const currentConfig = question.choice_config || {};
    let configChanged = false;

    // Handle options update
    if (req.body.options !== undefined) {
      currentConfig.options = Array.isArray(req.body.options) ? req.body.options : req.body.options;
      configChanged = true;
    }
    
    const effectiveRawOptions = (currentConfig.options) || [];
    const effectiveLabels = Array.isArray(effectiveRawOptions) ? effectiveRawOptions.map(o => (typeof o === 'string') ? o : (o && o.label)).filter(v => typeof v === 'string') : [];

    // Derivar correct_option_index a partir de is_correct quando opções forem objetos e type radio
    if (effectiveType === 'radio' && req.body.correct_option_index === undefined && Array.isArray(req.body.options)) {
      const markers = req.body.options.filter(o => o && typeof o === 'object' && o.is_correct === true);
      if (markers.length > 1) {
        return res.status(400).json({ error: 'Validation error', message: 'Apenas uma opção pode ser marcada como is_correct' });
      }
      if (markers.length === 1) {
        const idx = req.body.options.findIndex(o => o && typeof o === 'object' && o.is_correct === true);
        if (idx < 0 || idx >= effectiveLabels.length) {
          return res.status(400).json({ error: 'Validation error', message: 'Opção correta inválida' });
        }
        currentConfig.correct_option_index = idx;
        configChanged = true;
      }
    }

    if (req.body.correct_option_index !== undefined) {
      if (effectiveType !== 'radio') {
        return res.status(400).json({ error: 'Validation error', message: 'correct_option_index só é válido para perguntas do tipo radio' });
      }
      const idx = parseInt(req.body.correct_option_index, 10);
      if (!Array.isArray(effectiveRawOptions) || idx < 0 || idx >= effectiveLabels.length) {
        return res.status(400).json({ error: 'Validation error', message: 'correct_option_index fora do intervalo de options' });
      }
      currentConfig.correct_option_index = idx;
      configChanged = true;
    }

    if (req.body.max_choices !== undefined) {
      if (effectiveType !== 'checkbox') {
        return res.status(400).json({ error: 'Validation error', message: 'max_choices só é válido para perguntas do tipo checkbox' });
      }
      const mc = parseInt(req.body.max_choices, 10);
      if (!(mc >= 1)) {
        return res.status(400).json({ error: 'Validation error', message: 'max_choices deve ser >= 1' });
      }
      currentConfig.max_choices = mc;
      configChanged = true;
    }

    if (req.body.show_results !== undefined) {
      currentConfig.show_results = !!req.body.show_results;
      configChanged = true;
    }

    if (configChanged) {
      updateData.choice_config = currentConfig;
    }

    // Garantir que só campos permitidos sejam atualizados
    for (const key of Object.keys(updateData)) {
      if (!allowed.includes(key)) delete updateData[key];
    }

    await question.update(updateData);
    return res.json({ success: true, message: 'Pergunta atualizada com sucesso', data: { question } });
  } catch (error) {
    console.error('Patch question error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/questions/{questionId}:
 *   delete:
 *     summary: Excluir pergunta do evento (remove respostas relacionadas)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: path
 *         name: questionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pergunta excluída com sucesso
 *       404:
 *         description: Evento/Pergunta não encontrado
 */
router.delete('/:id/questions/:questionId', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id, questionId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not found', message: 'Evento não encontrado' });
    }
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const question = await EventQuestion.findOne({ where: { id: questionId, event_id: event.id } });
    if (!question) {
      return res.status(404).json({ error: 'Not found', message: 'Pergunta não encontrada' });
    }

    // Remover respostas associadas à pergunta (segurança adicional além de constraints)
    await EventAnswer.destroy({ where: { question_id: question.id } });
    await question.destroy();

    return res.json({ success: true, message: 'Pergunta excluída com sucesso' });
  } catch (error) {
    console.error('Delete question error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/checkin/lookup:
 *   post:
 *     summary: Buscar convidados por nome/email/documento (portaria)
 *     tags: [Event Guests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               query:
 *                 type: string
 *     responses:
 *       200:
 *         description: Possíveis matches para check-in
 */
router.post('/:id/checkin/lookup', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const { query } = req.body;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const where = { event_id: event.id };
    if (query) {
      where[Op.or] = [
        { guest_name: { [Op.like]: `%${query}%` } },
        { guest_email: { [Op.like]: `%${query}%` } },
        { guest_document_number: { [Op.like]: `%${query}%` } }
      ];
    }
    const guests = await EventGuest.findAll({ where, limit: 20 });
    return res.json({ success: true, data: { guests } });
  } catch (error) {
    console.error('Lookup event guests error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/checkin/confirm:
 *   post:
 *     summary: Confirmar check-in de convidado (portaria)
 *     tags: [Event Guests]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [guest_id]
 *             properties:
 *               guest_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Check-in confirmado
 */
router.post('/:id/checkin/confirm', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  try {
    const { id } = req.params;
    const { guest_id } = req.body;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const guest = await EventGuest.findOne({ where: { id_code: guest_id, event_id: event.id } });
    if (!guest) return res.status(404).json({ error: 'Not Found', message: 'Convidado não encontrado' });

    await guest.update({ check_in_at: new Date(), check_in_method: 'staff_manual', authorized_by_user_id: req.user.userId });
    return res.json({ success: true, data: { guest: { ...guest.toJSON(), id: guest.id_code, id_code: undefined } } });
  } catch (error) {
    console.error('Confirm check-in error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/checkin/manual:
 *   post:
 *     summary: Cadastro rápido e check-in (portaria)
 *     tags: [Event Guests]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [guest_name]
 *             properties:
 *               guest_name: { type: string }
 *               guest_phone: { type: string }
 *               guest_document_type: { type: string, enum: [rg, cpf, passport] }
 *               guest_document_number: { type: string }
 *               type: { type: string, enum: [normal, vip, premium] }
 *     responses:
 *       201:
 *         description: Convidado criado com check-in
 */
router.post('/:id/checkin/manual', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const { guest_name, guest_phone, guest_document_type, guest_document_number, type } = req.body;
    if (!guest_name) return res.status(400).json({ error: 'Validation error', message: 'guest_name é obrigatório' });

    const payload = {
      event_id: event.id,
      user_id: null,
      guest_name,
      guest_email: null,
      guest_phone: guest_phone || null,
      guest_document_type: guest_document_type || null,
      guest_document_number: guest_document_number || null,
      type: ['normal', 'vip', 'premium'].includes(type) ? type : 'normal',
      source: 'walk_in',
      rsvp_confirmed: false,
      rsvp_at: null,
      invited_at: new Date(),
      invited_by_user_id: req.user.userId,
      check_in_at: new Date(),
      check_in_method: 'staff_manual',
      authorized_by_user_id: req.user.userId
    };

    const created = await EventGuest.create(payload);
    return res.status(201).json({ success: true, data: { guest: { ...created.toJSON(), id: created.id_code, id_code: undefined } } });
  } catch (error) {
    console.error('Manual check-in error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      const payload = formatDuplicateError(error);
      return res.status(409).json(payload);
    }
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/guests/{guestId}:
 *   patch:
 *     summary: Atualizar convidado do evento
 *     tags: [Event Guests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: path
 *         name: guestId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               guest_name: { type: string }
 *               guest_email: { type: string }
 *               guest_phone: { type: string }
 *               guest_document_type: { type: string, enum: [rg, cpf, passport] }
 *               guest_document_number: { type: string }
 *               type: { type: string, enum: [normal, vip, premium] }
 *               rsvp_confirmed: { type: boolean }
 *               rsvp_at: { type: string, format: date-time, nullable: true }
 *               check_in_at: { type: string, format: date-time, nullable: true }
 *     responses:
 *       200:
 *         description: Convidado atualizado com sucesso
 */
router.patch('/:id/guests/:guestId', authenticateToken, requireRole('admin', 'master'), [
  body('guest_email').optional().isEmail(),
  body('guest_phone').optional().isString(),
  body('guest_document_type').optional().isIn(['rg', 'cpf', 'passport']),
  body('type').optional().isIn(['normal', 'vip', 'premium']),
  body('rsvp_confirmed').optional().isBoolean(),
  body('rsvp_at').optional({ nullable: true }).isISO8601().toDate(),
  body('check_in_at').optional({ nullable: true }).isISO8601().toDate(),
  body('check_in_method').optional().isIn(['google', 'staff_manual', 'invited_qr', 'auto_checkin']),
  body('authorized_by_user_id').optional().isInt()
], async (req, res) => {
  try {
    const { id, guestId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    const guest = await EventGuest.findOne({ where: { id_code: guestId, event_id: event.id } });
    if (!guest) return res.status(404).json({ error: 'Not Found', message: 'Convidado não encontrado' });

    const update = {};
    const fields = ['guest_name', 'guest_email', 'guest_phone', 'guest_document_type', 'guest_document_number', 'type', 'rsvp_confirmed'];
    for (const f of fields) if (req.body[f] !== undefined) update[f] = req.body[f];
    if (req.body.rsvp_at !== undefined) {
      update.rsvp_at = req.body.rsvp_at ? new Date(req.body.rsvp_at) : null;
      // Se rsvp_confirmed não foi explicitamente enviado, sincroniza com rsvp_at
      if (update.rsvp_confirmed === undefined) {
        update.rsvp_confirmed = !!update.rsvp_at;
      }
    }

    // Permitir remoção/ajuste de check-in
    if (req.body.check_in_at !== undefined) {
      update.check_in_at = req.body.check_in_at ? new Date(req.body.check_in_at) : null;
      if (update.check_in_at === null) {
        update.check_in_method = null;
        update.authorized_by_user_id = null;
      } else {
        // Se está marcando check-in e método/autorizador não foram enviados,
        // definir defaults com base no usuário logado
        if (req.body.check_in_method === undefined && update.check_in_method === undefined) {
          update.check_in_method = 'staff_manual';
        }
        if (req.body.authorized_by_user_id === undefined && update.authorized_by_user_id === undefined) {
          update.authorized_by_user_id = req.user.userId;
        }
      }
    }

    if (req.body.check_in_method !== undefined) {
      update.check_in_method = req.body.check_in_method;
    }
    if (req.body.authorized_by_user_id !== undefined) {
      update.authorized_by_user_id = req.body.authorized_by_user_id;
    }

    await guest.update(update);
    return res.json({ success: true, data: { guest: { ...guest.toJSON(), id: guest.id_code, id_code: undefined } } });
  } catch (error) {
    console.error('Update event guest error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      const payload = formatDuplicateError(error);
      return res.status(409).json(payload);
    }
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/guests:
 *   get:
 *     summary: Listar convidados do evento com filtros
 *     tags: [Event Guests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [normal, vip, premium]
 *       - in: query
 *         name: source
 *         schema:
 *           type: string
 *           enum: [invited, walk_in]
 *       - in: query
 *         name: checked_in
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: checkin
 *         schema:
 *           type: boolean
 *         description: Alias de checked_in
 *       - in: query
 *         name: rsvp
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: page_size
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Lista unificada de convidados
 */
router.get('/:id/guests', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });

    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.page_size || '20', 10), 1), 100);
    const offset = (page - 1) * pageSize;

    const { search, type, source, checked_in, checkin, rsvp } = req.query;
    const where = { event_id: event.id };
    if (type && ['normal', 'vip', 'premium'].includes(type)) where.type = type;
    if (source && ['invited', 'walk_in'].includes(source)) where.source = source;
    const checkedParam = checked_in !== undefined ? checked_in : checkin;
    if (checkedParam !== undefined) {
      if (String(checkedParam).toLowerCase() === 'true') {
        where.check_in_at = { [Op.ne]: null };
      } else {
        where.check_in_at = null;
      }
    }
    if (rsvp !== undefined) {
      where.rsvp_confirmed = String(rsvp).toLowerCase() === 'true';
    }
    if (search) {
      where[Op.or] = [
        { guest_name: { [Op.like]: `%${search}%` } },
        { guest_email: { [Op.like]: `%${search}%` } },
        { guest_document_number: { [Op.like]: `%${search}%` } }
      ];
    }

    const total = await EventGuest.count({ where });
    const guests = await EventGuest.findAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'email', 'phone', 'avatar_url'] }],
      order: [['created_at', 'DESC']],
      offset,
      limit: pageSize
    });

    const normalized = guests.map(g => {
      const origin_status = g.source === 'invited'
        ? 'pre_list'
        : (g.check_in_method === 'google' ? 'open_login' : 'front_desk');
      return {
        id: g.id_code,
        display_name: g.user?.name || g.guest_name,
        avatar_url: g.user?.avatar_url || null,
        email: g.user?.email || g.guest_email || null,
        document: g.guest_document_number ? { type: g.guest_document_type, number: g.guest_document_number } : null,
        phone: g.user?.phone || g.guest_phone || null,
        type: g.type,
        origin_status,
        rsvp: !!g.rsvp_at,
        rsvp_at: g.rsvp_at,
        check_in_at: g.check_in_at,
        checked_in: !!g.check_in_at,
        check_in_method: g.check_in_method
      };
    });

    // Estatísticas agregadas do evento (não filtradas pelo query atual)
    const totalGuestsAll = await EventGuest.count({ where: { event_id: event.id } });
    const rsvpCountAll = await EventGuest.count({ where: { event_id: event.id, rsvp_confirmed: true } });
    const checkinCountAll = await EventGuest.count({ where: { event_id: event.id, check_in_at: { [Op.ne]: null } } });

    const sourceAgg = await EventGuest.findAll({
      where: { event_id: event.id },
      attributes: ['source', [fn('COUNT', col('*')), 'count']],
      group: ['source']
    });
    const typeAgg = await EventGuest.findAll({
      where: { event_id: event.id },
      attributes: ['type', [fn('COUNT', col('*')), 'count']],
      group: ['type']
    });
    const methodAgg = await EventGuest.findAll({
      where: { event_id: event.id, check_in_method: { [Op.ne]: null } },
      attributes: ['check_in_method', [fn('COUNT', col('*')), 'count']],
      group: ['check_in_method']
    });

    const by_source = { invited: 0, walk_in: 0 };
    for (const row of sourceAgg) {
      by_source[row.get('source')] = parseInt(row.get('count'), 10);
    }

    const by_type = { normal: 0, vip: 0, premium: 0 };
    for (const row of typeAgg) {
      by_type[row.get('type')] = parseInt(row.get('count'), 10);
    }

    const by_check_in_method = { google: 0, staff_manual: 0, invited_qr: 0 };
    for (const row of methodAgg) {
      const key = row.get('check_in_method');
      if (by_check_in_method[key] !== undefined) {
        by_check_in_method[key] = parseInt(row.get('count'), 10);
      }
    }

    const stats = {
      total_guests: totalGuestsAll,
      rsvp_count: rsvpCountAll,
      checkin_count: checkinCountAll,
      by_source,
      by_type,
      by_check_in_method
    };

    return res.json({ success: true, data: { guests: normalized, stats }, meta: { total, page, page_size: pageSize, pages: Math.ceil(total / pageSize) } });
  } catch (error) {
    console.error('List event guests error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/guests:
 *   post:
 *     summary: Criar convidados (suporta bulk) para o evento
 *     tags: [Event Guests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               guests:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [guest_name]
 *                   properties:
 *                     guest_name: { type: string }
 *                     guest_email: { type: string }
 *                     guest_phone: { type: string }
 *                     guest_document_type: { type: string, enum: [rg, cpf, passport] }
 *                     guest_document_number: { type: string }
 *                     type: { type: string, enum: [normal, vip, premium] }
 *                     source: { type: string, enum: [invited, walk_in] }
 *                     rsvp_confirmed:
 *                       type: boolean
 *                       description: Se omitido, será definido como !!rsvp_at
 *                     rsvp_at:
 *                       type: string
 *                       format: date-time
 *                 description: "Se rsvp_confirmed não for enviado, será sincronizado como !!rsvp_at"
 *     responses:
 *       201:
 *         description: Convidados criados
 */
router.post('/:id/guests', authenticateToken, requireRole('admin', 'master'), [
  body('guests').isArray({ min: 1 }).withMessage('guests deve ser uma lista com ao menos 1 item'),
], async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    const { guests } = req.body;
    const toCreate = guests.map(g => ({
      event_id: event.id,
      user_id: g.user_id || null,
      guest_name: g.guest_name,
      guest_email: g.guest_email || null,
      guest_phone: g.guest_phone || null,
      guest_document_type: g.guest_document_type || null,
      guest_document_number: g.guest_document_number || null,
      type: ['normal', 'vip', 'premium'].includes(g.type) ? g.type : 'normal',
      source: ['invited', 'walk_in'].includes(g.source) ? g.source : 'invited',
      rsvp_confirmed: g.rsvp_confirmed !== undefined ? !!g.rsvp_confirmed : !!g.rsvp_at,
      rsvp_at: g.rsvp_at ? new Date(g.rsvp_at) : null,
      invited_at: new Date(),
      invited_by_user_id: req.user.userId
    }));

    const created = await EventGuest.bulkCreate(toCreate, { validate: true, returning: true });
    const formatted = created.map(g => {
      const json = g.toJSON();
      return { ...json, id: g.id_code, id_code: undefined };
    });
    return res.status(201).json({ success: true, data: { guests: formatted } });
  } catch (error) {
    console.error('Create event guests error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      const payload = formatDuplicateError(error);
      return res.status(409).json(payload);
    }
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.get('/:id/ticket-types', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const event = await Event.findOne({ where: { id_code: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const rows = await EventTicketType.findAll({
      where: { event_id: event.id },
      order: [['sort_order', 'ASC'], ['created_at', 'ASC']]
    });

    return res.json({
      success: true,
      data: rows.map(r => {
        const j = r.toJSON();
        return { ...j, id: j.id_code };
      })
    });
  } catch (error) {
    console.error('List ticket types error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/ticket-types', authenticateToken, requireRole('admin', 'master'), requireModule('events'), [
  body('name').trim().isLength({ min: 2, max: 255 }),
  body('total_quantity').optional({ nullable: true }).isInt({ min: 0 }).toInt(),
  body('price_amount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('currency').optional({ nullable: true }).isString(),
  body('start_at').optional({ nullable: true }).isISO8601(),
  body('end_at').optional({ nullable: true }).isISO8601(),
  body('sort_order').optional({ nullable: true }).isInt().toInt(),
  body('status').optional({ nullable: true }).isIn(['active', 'inactive'])
], async (req, res) => {
  try {
    const event = await Event.findOne({ where: { id_code: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    const row = await EventTicketType.create({
      event_id: event.id,
      name: req.body.name,
      description: req.body.description || null,
      price_amount: req.body.price_amount !== undefined && req.body.price_amount !== null ? req.body.price_amount : 0,
      currency: req.body.currency || 'BRL',
      total_quantity: req.body.total_quantity !== undefined ? req.body.total_quantity : null,
      start_at: req.body.start_at ? new Date(req.body.start_at) : null,
      end_at: req.body.end_at ? new Date(req.body.end_at) : null,
      sort_order: req.body.sort_order !== undefined && req.body.sort_order !== null ? req.body.sort_order : 0,
      status: req.body.status || 'active'
    });

    const j = row.toJSON();
    return res.status(201).json({ success: true, data: { ...j, id: j.id_code } });
  } catch (error) {
    console.error('Create ticket type error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.patch('/:id/ticket-types/:ticket_type_id', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const event = await Event.findOne({ where: { id_code: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const ticketType = await EventTicketType.findOne({ where: { id_code: req.params.ticket_type_id, event_id: event.id } });
    if (!ticketType) return res.status(404).json({ error: 'Not Found', message: 'Lote/Tipo não encontrado' });

    const payload = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) payload.name = req.body.name;
    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) payload.description = req.body.description;
    if (Object.prototype.hasOwnProperty.call(req.body, 'price_amount')) payload.price_amount = req.body.price_amount;
    if (Object.prototype.hasOwnProperty.call(req.body, 'currency')) payload.currency = req.body.currency;
    if (Object.prototype.hasOwnProperty.call(req.body, 'total_quantity')) payload.total_quantity = req.body.total_quantity;
    if (Object.prototype.hasOwnProperty.call(req.body, 'start_at')) payload.start_at = req.body.start_at ? new Date(req.body.start_at) : null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'end_at')) payload.end_at = req.body.end_at ? new Date(req.body.end_at) : null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'sort_order')) payload.sort_order = req.body.sort_order;
    if (Object.prototype.hasOwnProperty.call(req.body, 'status')) payload.status = req.body.status;

    await ticketType.update(payload);
    const j = ticketType.toJSON();
    return res.json({ success: true, data: { ...j, id: j.id_code } });
  } catch (error) {
    console.error('Update ticket type error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/tickets/checkin', authenticateToken, requireRole('admin', 'master'), requireModule('events'), [
  body('qr_token').isString().withMessage('qr_token é obrigatório')
], async (req, res) => {
  try {
    const event = await Event.findOne({ where: { id_code: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    let payload;
    try {
      payload = verifyEventTicketQrToken(req.body.qr_token);
    } catch (e) {
      const code = e && e.name ? e.name : (e && e.code ? e.code : null);
      if (code === 'TokenExpiredError') {
        return res.status(400).json({ error: 'Validation error', message: 'QR expirado' });
      }
      return res.status(400).json({ error: 'Validation error', message: 'QR inválido' });
    }

    if (String(payload.eid) !== String(req.params.id)) {
      return res.status(400).json({ error: 'Validation error', message: 'QR não pertence a este evento' });
    }

    const ticket = await EventTicket.findOne({
      where: { id_code: payload.tid, event_id: event.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }]
    });
    if (!ticket) return res.status(404).json({ error: 'Not Found', message: 'Ingresso não encontrado' });

    if (ticket.status === 'checked_in') {
      return res.json({ success: true, data: { ticket_id: ticket.id_code, status: ticket.status, already_checked_in: true } });
    }
    if (ticket.status !== 'reserved') {
      return res.status(400).json({ error: 'Validation error', message: 'Ingresso inválido para check-in' });
    }
    if (ticket.expires_at && new Date(ticket.expires_at).getTime() < Date.now()) {
      await ticket.update({ status: 'expired' });
      return res.status(400).json({ error: 'Validation error', message: 'Ingresso expirado' });
    }

    const now = new Date();
    await sequelize.transaction(async (t) => {
      await ticket.update({ status: 'checked_in', checked_in_at: now }, { transaction: t });

      const userId = ticket.user_id;
      const userName = ticket.user ? ticket.user.name : null;
      const userEmail = ticket.user ? ticket.user.email : null;

      const existingGuest = await EventGuest.findOne({ where: { event_id: event.id, user_id: userId }, transaction: t });
      if (!existingGuest) {
        await EventGuest.create({
          event_id: event.id,
          user_id: userId,
          guest_name: userName || 'Guest',
          guest_email: userEmail || null,
          type: 'normal',
          source: 'invited',
          rsvp_confirmed: true,
          rsvp_at: now,
          invited_at: now,
          invited_by_user_id: req.user.userId
        }, { transaction: t });
      } else if (!existingGuest.rsvp_confirmed) {
        await existingGuest.update({ rsvp_confirmed: true, rsvp_at: now }, { transaction: t });
      }
    });

    return res.json({ success: true, data: { ticket_id: ticket.id_code, status: 'checked_in', checked_in_at: now } });
  } catch (error) {
    console.error('Ticket checkin (qr) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/tickets/:ticket_id/checkin', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const event = await Event.findOne({ where: { id_code: req.params.id } });
    if (!event) return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const ticket = await EventTicket.findOne({
      where: { id_code: req.params.ticket_id, event_id: event.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }]
    });
    if (!ticket) return res.status(404).json({ error: 'Not Found', message: 'Ingresso não encontrado' });

    if (ticket.status === 'checked_in') {
      return res.json({ success: true, data: { ticket_id: ticket.id_code, status: ticket.status, already_checked_in: true } });
    }
    if (ticket.status !== 'reserved') {
      return res.status(400).json({ error: 'Validation error', message: 'Ingresso inválido para check-in' });
    }
    if (ticket.expires_at && new Date(ticket.expires_at).getTime() < Date.now()) {
      await ticket.update({ status: 'expired' });
      return res.status(400).json({ error: 'Validation error', message: 'Ingresso expirado' });
    }

    const now = new Date();
    await sequelize.transaction(async (t) => {
      await ticket.update({ status: 'checked_in', checked_in_at: now }, { transaction: t });

      const userId = ticket.user_id;
      const userName = ticket.user ? ticket.user.name : null;
      const userEmail = ticket.user ? ticket.user.email : null;

      const existingGuest = await EventGuest.findOne({ where: { event_id: event.id, user_id: userId }, transaction: t });
      if (!existingGuest) {
        await EventGuest.create({
          event_id: event.id,
          user_id: userId,
          guest_name: userName || 'Guest',
          guest_email: userEmail || null,
          type: 'normal',
          source: 'invited',
          rsvp_confirmed: true,
          rsvp_at: now,
          invited_at: now,
          invited_by_user_id: req.user.userId
        }, { transaction: t });
      } else if (!existingGuest.rsvp_confirmed) {
        await existingGuest.update({ rsvp_confirmed: true, rsvp_at: now }, { transaction: t });
      }
    });

    return res.json({ success: true, data: { ticket_id: ticket.id_code, status: 'checked_in', checked_in_at: now } });
  } catch (error) {
    console.error('Ticket checkin error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

module.exports = router;
/**
 * @swagger
 * /api/v1/events/{id}/questions-with-answers:
 *   get:
 *     summary: Retorna perguntas do evento com respostas pré-preenchidas (auth opcional)
 *     tags: [Events]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: query
 *         name: guest_code
 *         schema:
 *           type: string
 *         description: Necessário quando não autenticado para pré-preencher respostas
 *       - in: header
 *         name: Authorization
 *         schema:
 *           type: string
 *         description: Bearer token. Quando presente e válido, retorna perguntas privadas também.
 *     responses:
 *       200:
 *         description: Perguntas com respostas pré-preenchidas
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 event_id: 123
 *                 id_code: "uuid-do-evento"
 *                 total_questions: 7
 *                 questions:
 *                   - id: 10
 *                     text: "Qual seu estilo favorito?"
 *                     type: "radio"
 *                     options: ["IPA","Lager","Stout"]
 *                     selected_labels: ["IPA"]
 *       401:
 *         description: Token inválido ou usuário não encontrado (quando Authorization enviado)
 *       404:
 *         description: Evento não encontrado
 */
// GET /api/v1/events/:id/questions-with-answers — alias com auth opcional
router.get('/:id/questions-with-answers', async (req, res) => {
  try {
    const { id } = req.params;
    const { guest_code } = req.query;

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let isAuthenticated = false;
    let authUserId = null;
    if (token) {
      try {
        const isBlocked = await TokenBlocklist.findByPk(token);
        if (!isBlocked) {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          const user = await User.findByPk(decoded.userId);
          if (user) {
            isAuthenticated = true;
            authUserId = decoded.userId;
          }
        }
      } catch (err) {
        // Token inválido ou expirado em rota opcional: ignorar e seguir como guest
      }
    }

    if (!isAuthenticated && !guest_code) {
      // Relaxar validação: se não tiver guest_code, retorna perguntas sem preenchimento
    }

    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const questions = await EventQuestion.findAll({
      where: isAuthenticated ? { event_id: event.id } : { event_id: event.id, is_public: true },
      attributes: [
        'id', 
        ['question', 'question_text'], // Aliasing 'question' column to 'question_text'
        ['type', 'question_type'],     // Aliasing 'type' column to 'question_type'
        ['choice_config', 'options'],  // Aliasing 'choice_config' column to 'options'
        'order_index'
      ],
      order: [['order_index', 'ASC']]
    });

    let response = null;
    if (isAuthenticated) {
      response = await EventResponse.findOne({ where: { event_id: event.id, user_id: authUserId } });
      if (!response && guest_code) {
        response = await EventResponse.findOne({ where: { event_id: event.id, guest_code } });
      }
    } else if (guest_code) {
      response = await EventResponse.findOne({ where: { event_id: event.id, guest_code } });
    }

    const answers = response ? await EventAnswer.findAll({ where: { response_id: response.id } }) : [];
    const answersByQuestion = new Map(answers.map(a => [a.question_id, a]));

    const payloadQuestions = questions.map(q => {
      const raw = q.options;
      let items = [];
      if (Array.isArray(raw)) {
        items = raw;
      } else if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) items = parsed;
          else if (parsed && Array.isArray(parsed.options)) items = parsed.options;
          else if (parsed && Array.isArray(parsed.labels)) items = parsed.labels;
        } catch (_) {
          items = [];
        }
      } else if (raw && typeof raw === 'object') {
        if (Array.isArray(raw.options)) items = raw.options;
        else if (Array.isArray(raw.labels)) items = raw.labels;
      }

      const labels = items
        .map(o => (typeof o === 'string') ? o : (o && o.label))
        .filter(v => typeof v === 'string' && v.length > 0)
        .map(v => v.replace(/\s*\[c\]\s*$/i, ''));
      const ans = answersByQuestion.get(q.id);
      let selected_labels = undefined;
      let selected_value = undefined;
      if (ans) {
        if (q.question_type === 'radio') {
          if (typeof ans.answer_text === 'string' && ans.answer_text.length) {
            selected_labels = [ans.answer_text];
          }
        } else if (q.question_type === 'checkbox') {
          if (Array.isArray(ans.answer_json)) {
            selected_labels = ans.answer_json;
          } else if (typeof ans.answer_json === 'string') {
            try {
              const parsed = JSON.parse(ans.answer_json);
              if (Array.isArray(parsed)) selected_labels = parsed;
            } catch (_) {
              // ignorar se não for JSON válido
            }
          } else if (typeof ans.answer_text === 'string') {
            let arr = [];
            try {
              const parsed = JSON.parse(ans.answer_text);
              if (Array.isArray(parsed)) arr = parsed;
            } catch (_) {
              if (ans.answer_text.includes(',')) {
                arr = ans.answer_text.split(',').map(s => s.trim()).filter(Boolean);
              } else if (ans.answer_text.trim().length) {
                arr = [ans.answer_text.trim()];
              }
            }
            if (arr.length) selected_labels = arr;
          }
        } else if (q.question_type === 'rating') {
          if (ans.answer_json && typeof ans.answer_json === 'object' && ans.answer_json.value != null) {
            const v = Number(ans.answer_json.value);
            if (!Number.isNaN(v)) selected_value = v;
          } else if (typeof ans.answer_json === 'string') {
            try {
              const parsed = JSON.parse(ans.answer_json);
              if (parsed && typeof parsed === 'object' && parsed.value != null) {
                const v = Number(parsed.value);
                if (!Number.isNaN(v)) selected_value = v;
              }
            } catch (_) {
              // ignorar se não for JSON válido
            }
          } else if (typeof ans.answer_text === 'string') {
            const v = Number(ans.answer_text);
            if (!Number.isNaN(v)) selected_value = v;
          }
        } else if (q.question_type === 'text' || q.question_type === 'textarea') {
          if (typeof ans.answer_text === 'string' && ans.answer_text.trim().length) {
            selected_labels = [ans.answer_text.trim()];
          }
        }
      }
      if (Array.isArray(selected_labels)) {
        selected_labels = selected_labels.map(v => typeof v === 'string' ? v.replace(/\s*\[c\]\s*$/i, '') : v);
      }
      return {
        id: q.id,
        text: q.question_text,
        type: q.question_type,
        options: labels.length ? labels : null,
        selected_labels,
        selected_value
      };
    });

    return res.json({
      success: true,
      data: {
        event_id: event.id,
        id_code: event.id_code,
        total_questions: payloadQuestions.length,
        questions: payloadQuestions
      }
    });
  } catch (error) {
    console.error('Questions with answers (v1 alias) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});
/**
 * @swagger
 * /api/v1/events/{id}/responses:
 *   post:
 *     summary: Enviar respostas de evento (autenticado)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answers]
 *             properties:
 *               selfie_url:
 *                 type: string
 *               answers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [question_id]
 *                   properties:
 *                     question_id:
 *                       type: integer
 *                     answer_text:
 *                       type: string
 *                     answer_json:
 *                       type: object
 *           example:
 *             selfie_url: "https://example.com/selfies/user-42.jpg"
 *             answers:
 *               - question_id: 101
 *                 answer_json:
 *                   selected_labels: ["IPA"]
 *               - question_id: 102
 *                 answer_json:
 *                   selected_labels: ["Pils", "Munich"]
 *     responses:
 *       201:
 *         description: Respostas registradas com sucesso
 *       404:
 *         description: Evento não encontrado
 *       409:
 *         description: Usuário já respondeu este evento
 */
router.post('/:id/responses', authenticateToken, [
  body('selfie_url').optional().isURL().withMessage('selfie_url inválida'),
  body('answers').isArray({ min: 1 }).withMessage('answers deve ser uma lista')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  const { id } = req.params;
  const { selfie_url, answers } = req.body;

  try {
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    // Carregar usuário para obter id_code
    const user = await User.findByPk(req.user.userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuário não encontrado' });
    }

    // Verifica duplicidade por (event_id, user_id)
    const already = await EventResponse.findOne({ where: { event_id: event.id, user_id: user.id } });
    if (already) {
      return res.status(409).json({ error: 'Duplicate entry', message: 'Usuário já respondeu este evento' });
    }

    const t = await sequelize.transaction();
    try {
      // valida perguntas pertencem ao evento
    const eventQuestions = await EventQuestion.findAll({
      where: { event_id: event.id },
      attributes: ['id', 'question_type', 'options', 'is_required', 'max_choices'],
      transaction: t
    });
    const questionById = new Map(eventQuestions.map(q => [q.id, q]));

    for (const ans of answers) {
      const q = questionById.get(ans.question_id);
      if (!q) {
        throw Object.assign(new Error(`Pergunta ${ans.question_id} não pertence ao evento`), { statusCode: 400 });
      }
      if (ans.answer_text == null && ans.answer_json == null) {
        throw Object.assign(new Error('Cada resposta deve ter answer_text ou answer_json'), { statusCode: 400 });
      }

      const rawOpts = Array.isArray(q.options) ? q.options : [];
      const labels = rawOpts.map(o => (typeof o === 'string') ? o : (o && o.label)).filter(v => typeof v === 'string');
      if (q.question_type === 'radio') {
        const val = ans.answer_text;
        if (typeof val !== 'string') {
          throw Object.assign(new Error('Pergunta radio requer answer_text string'), { statusCode: 400 });
        }
        if (labels.length && !labels.includes(val)) {
          throw Object.assign(new Error('Resposta não corresponde às opções disponíveis'), { statusCode: 400 });
        }
      } else if (q.question_type === 'checkbox') {
        const arr = ans.answer_json;
        if (!Array.isArray(arr)) {
          throw Object.assign(new Error('Pergunta checkbox requer answer_json como array de strings'), { statusCode: 400 });
        }
        const unique = Array.from(new Set(arr));
        if (q.is_required && unique.length === 0) {
          throw Object.assign(new Error('Pergunta obrigatória requer ao menos uma seleção'), { statusCode: 400 });
        }
        if (typeof q.max_choices === 'number' && unique.length > q.max_choices) {
          throw Object.assign(new Error(`Máximo de ${q.max_choices} seleções permitido`), { statusCode: 400 });
        }
        if (labels.length && !unique.every(v => typeof v === 'string' && labels.includes(v))) {
          throw Object.assign(new Error('Alguma seleção não corresponde às opções disponíveis'), { statusCode: 400 });
        }
      }
    }

      const response = await EventResponse.create({
        event_id: event.id,
        user_id: user.id,
        guest_code: user.id_code,
        selfie_url: selfie_url || null
      }, { transaction: t });

      const toCreate = answers.map(a => ({
        response_id: response.id,
        question_id: a.question_id,
        answer_text: a.answer_text || null,
        answer_json: a.answer_json || null
      }));

      await EventAnswer.bulkCreate(toCreate, { transaction: t });

      await t.commit();
      return res.status(201).json({ success: true, response_id: response.id });
    } catch (err) {
      await t.rollback();
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: 'Validation error', message: err.message });
      }
      throw err;
    }
  } catch (error) {
    console.error('Create event response (auth) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/responses:
 *   patch:
 *     summary: Continuar/atualizar respostas do evento (upsert por usuário)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answers]
 *             properties:
 *               selfie_url:
 *                 type: string
 *               answers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [question_id]
 *                   properties:
 *                     question_id:
 *                       type: integer
 *                     answer_text:
 *                       type: string
 *                     answer_json:
 *                       type: object
 *           example:
 *             selfie_url: "https://example.com/selfies/user-42.jpg"
 *             answers:
 *               - question_id: 101
 *                 answer_text: "IPA"
 *               - question_id: 102
 *                 answer_json: ["Pils", "Munich"]
 *     responses:
 *       200:
 *         description: Respostas atualizadas com sucesso
 *       404:
 *         description: Evento não encontrado
 */
// PATCH /api/v1/events/:id/responses — upsert por user_id
router.patch('/:id/responses', authenticateToken, [
  body('selfie_url').optional().isURL().withMessage('selfie_url inválida'),
  body('answers').isArray({ min: 1 }).withMessage('answers deve ser uma lista')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  const { id } = req.params;
  const { selfie_url, answers } = req.body;

  try {
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const user = await User.findByPk(req.user.userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuário não encontrado' });
    }

    const t = await sequelize.transaction();
    try {
      // Carregar perguntas do evento (todas, não apenas públicas)
      const eventQuestions = await EventQuestion.findAll({
        where: { event_id: event.id },
        attributes: ['id', 'question_type', 'options', 'is_required', 'max_choices'],
        transaction: t
      });
      const questionById = new Map(eventQuestions.map(q => [q.id, q]));

      // Encontrar ou criar o response
      let response = await EventResponse.findOne({ where: { event_id: event.id, user_id: user.id }, transaction: t });
      
      // Atualizar selfie também no EventGuest, se fornecida
      if (selfie_url) {
        const guest = await EventGuest.findOne({ 
          where: { event_id: event.id, user_id: user.id },
          transaction: t 
        });
        if (guest) {
          guest.selfie_url = selfie_url;
          await guest.save({ transaction: t });
        }
      }

      if (!response) {
        response = await EventResponse.create({
          event_id: event.id,
          user_id: user.id,
          guest_code: user.id_code,
          selfie_url: selfie_url || null
        }, { transaction: t });
      } else if (selfie_url) {
        response.selfie_url = selfie_url;
        await response.save({ transaction: t });
      }

      // Validar e upsert respostas
      for (const ans of answers) {
        const q = questionById.get(ans.question_id);
        if (!q) {
          throw Object.assign(new Error(`Pergunta ${ans.question_id} não pertence ao evento`), { statusCode: 400 });
        }
        if (ans.answer_text == null && ans.answer_json == null) {
          throw Object.assign(new Error('Cada resposta deve ter answer_text ou answer_json'), { statusCode: 400 });
        }

        const rawOpts = Array.isArray(q.options) ? q.options : [];
        const labels = rawOpts.map(o => (typeof o === 'string') ? o : (o && o.label)).filter(v => typeof v === 'string');
        if (q.question_type === 'radio') {
          const val = ans.answer_text;
          if (typeof val !== 'string') {
            throw Object.assign(new Error('Pergunta radio requer answer_text string'), { statusCode: 400 });
          }
          if (labels.length && !labels.includes(val)) {
            throw Object.assign(new Error('Resposta não corresponde às opções disponíveis'), { statusCode: 400 });
          }
        } else if (q.question_type === 'checkbox') {
          const arr = ans.answer_json;
          if (!Array.isArray(arr)) {
            throw Object.assign(new Error('Pergunta checkbox requer answer_json como array de strings'), { statusCode: 400 });
          }
          const unique = Array.from(new Set(arr));
          if (q.is_required && unique.length === 0) {
            throw Object.assign(new Error('Pergunta obrigatória requer ao menos uma seleção'), { statusCode: 400 });
          }
          if (typeof q.max_choices === 'number' && unique.length > q.max_choices) {
            throw Object.assign(new Error(`Máximo de ${q.max_choices} seleções permitido`), { statusCode: 400 });
          }
          if (labels.length && !unique.every(v => typeof v === 'string' && labels.includes(v))) {
            throw Object.assign(new Error('Alguma seleção não corresponde às opções disponíveis'), { statusCode: 400 });
          }
        }

        const existing = await EventAnswer.findOne({
          where: { response_id: response.id, question_id: ans.question_id },
          transaction: t
        });
        if (existing) {
          existing.answer_text = ans.answer_text || null;
          existing.answer_json = ans.answer_json || null;
          await existing.save({ transaction: t });
        } else {
          await EventAnswer.create({
            response_id: response.id,
            question_id: ans.question_id,
            answer_text: ans.answer_text || null,
            answer_json: ans.answer_json || null
          }, { transaction: t });
        }
      }

      await t.commit();
      return res.json({ success: true, response_id: response.id });
    } catch (err) {
      await t.rollback();
      if (err.statusCode) {
        return res.status(err.statusCode).json({ error: 'Validation error', message: err.message });
      }
      throw err;
    }
  } catch (error) {
    console.error('Upsert event response (admin) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/responses:
 *   get:
 *     summary: Listar respostas do evento (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [submitted_at, guest_code]
 *       - in: query
 *         name: guest_code
 *         schema:
 *           type: string
 *       - in: query
 *         name: has_selfie
 *         schema:
 *           type: string
 *           enum: [true, false]
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: question_id
 *         schema:
 *           type: integer
 *       - in: query
 *         name: answer_contains
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista paginada de respostas (com dados de usuário e convidado)
 *       403:
 *         description: Acesso negado (somente master ou dono do evento)
 *       404:
 *         description: Evento não encontrado
 */
// GET /api/v1/events/:id/responses — listar respostas para datatables (admin/master)
router.get('/:id/responses', authenticateToken, requireRole('admin', 'master'), async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }
    // Apenas master ou dono do evento
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    // Query params
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const sortBy = ['created_at', 'guest_code'].includes(req.query.sort_by) ? req.query.sort_by : 'created_at';
    const { guest_code, has_selfie, from, to } = req.query;
    const questionId = req.query.question_id ? parseInt(req.query.question_id, 10) : undefined;
    const answerContains = req.query.answer_contains;

    // Base where for EventResponse
    const where = { event_id: event.id };
    
    // Date filter on created_at (was submitted_at)
    if (from || to) {
      where.created_at = {};
      if (from) where.created_at[Op.gte] = new Date(from);
      if (to) where.created_at[Op.lte] = new Date(to);
    }

    // Guest filter
    const guestWhere = {};
    if (guest_code) {
      guestWhere.id_code = { [Op.like]: `%${guest_code}%` };
    }
    if (typeof has_selfie !== 'undefined') {
      if (String(has_selfie).toLowerCase() === 'true') {
        guestWhere.selfie_url = { [Op.ne]: null };
      } else if (String(has_selfie).toLowerCase() === 'false') {
        guestWhere.selfie_url = { [Op.is]: null };
      }
    }

    // Include de respostas, opcionalmente com filtro por pergunta/resposta
    /*
    const answersInclude = {
      model: EventAnswer,
      as: 'answers',
      required: !!questionId || !!answerContains,
      where: {}
    };
    if (questionId) {
      answersInclude.where.question_id = questionId;
    }
    if (answerContains) {
      answersInclude.where.answer_text = { [Op.like]: `%${answerContains}%` };
    }
    if (Object.keys(answersInclude.where).length === 0) {
      delete answersInclude.where;
      answersInclude.required = false;
    }
    */

    // Force Association (Workaround for EagerLoadingError)
    if (!EventResponse.associations.guest) {
        EventResponse.belongsTo(EventGuest, { foreignKey: 'guest_id', as: 'guest' });
    }
    if (!EventGuest.associations.responses) {
        EventGuest.hasMany(EventResponse, { foreignKey: 'guest_id', as: 'responses' });
    }

    const offset = (page - 1) * limit;
    
    // Sort logic
    let orderClause = [[sortBy === 'guest_code' ? 'created_at' : sortBy, order]]; // Default fallback for guest_code sort for now

    const { rows, count } = await EventResponse.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: 'user',
          required: false,
          attributes: ['id_code', 'name', 'email', 'phone', 'avatar_url'],
          include: [
            {
              model: EventGuest,
              as: 'eventGuests',
              required: false,
              where: { event_id: event.id },
              attributes: ['guest_name', 'guest_email', 'guest_phone', 'type', 'check_in_at', 'source', 'check_in_method']
            }
          ]
        },
        {
            model: EventGuest,
            as: 'guest',
            required: Object.keys(guestWhere).length > 0, // Only required if filtering by guest
            where: guestWhere
        }
      ],
      order: orderClause,
      offset,
      limit,
      distinct: true
    });

    const data = rows.map(r => {
      // answersObj logic needs to be adapted for single table if needed
      // but currently EventResponse IS the answer row
      // The current controller logic assumes one EventResponse per Guest/User Submission containing multiple EventAnswers
      // BUT the DB schema shows EventResponse has question_id and response_text directly!
      // This means EventResponse IS the answer table now.
      
      const answersObj = {};
      // Adaptando: se cada linha é uma resposta, então "rows" são respostas individuais
      // Isso muda a lógica de listagem. Antes agrupava por submissão.
      // Se o front espera agrupado, teremos que agrupar aqui ou mudar a query.
      
      // Assumindo que queremos listar TODAS as respostas planas por enquanto
      answersObj[`q${r.question_id}`] = r.response_text || r.response_json;

      const user = r.user ? {
        id_code: r.user.id_code,
        name: r.user.name,
        email: r.user.email,
        phone: r.user.phone,
        avatar_url: r.user.avatar_url
      } : null;
      
      const guestFromEvent = r.user && Array.isArray(r.user.eventGuests) && r.user.eventGuests.length > 0
        ? r.user.eventGuests[0]
        : r.guest;

      const guest = guestFromEvent ? {
        guest_name: guestFromEvent.guest_name,
        guest_email: guestFromEvent.guest_email,
        guest_phone: guestFromEvent.guest_phone,
        type: guestFromEvent.type,
        check_in_at: guestFromEvent.check_in_at,
        source: guestFromEvent.source,
        check_in_method: guestFromEvent.check_in_method
      } : null;

      return {
        id: r.id,
        guest_id: r.guest_id,
        user_id: r.user_id,
        question_id: r.question_id,
        response: r.response_text || r.response_json,
        submitted_at: r.created_at,
        user,
        guest
      };
    });

    return res.json({
      success: true,
      data,
      meta: {
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('List event responses (admin) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/events/{id}/responses/export:
 *   get:
 *     summary: Exportar respostas em CSV (admin/master)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     responses:
 *       200:
 *         description: CSV com respostas do evento
 *       403:
 *         description: Acesso negado (somente master ou dono do evento)
 *       404:
 *         description: Evento não encontrado
 */
// GET /api/v1/events/:id/responses/export — CSV das respostas do evento (admin/master)
router.get('/:id/responses/export', authenticateToken, requireRole('admin', 'master'), requireModule('events'), async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id }, include: [{ model: EventQuestion, as: 'questions', order: [['order_index', 'ASC']] }] });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }
    // Apenas master ou dono do evento
    if (req.user.role !== 'master' && event.created_by !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied', message: 'Acesso negado' });
    }

    const responses = await EventResponse.findAll({
      where: { event_id: event.id },
      include: [{ model: EventAnswer, as: 'answers' }],
      order: [['submitted_at', 'DESC']]
    });

    const questionFields = (event.questions || []).map(q => ({
      id: q.id,
      header: `Q${q.id} - ${q.question_text}`
    }));

    const rows = responses.map(r => {
      const base = {
        guest_code: r.guest_code,
        selfie_url: r.selfie_url || '',
        submitted_at: r.submitted_at
      };
      for (const qf of questionFields) {
        const ans = (r.answers || []).find(a => a.question_id === qf.id);
        base[qf.header] = ans ? (ans.answer_text != null ? ans.answer_text : JSON.stringify(ans.answer_json)) : '';
      }
      return base;
    });

    const { Parser } = require('json2csv');
    const fields = ['guest_code', 'selfie_url', 'submitted_at', ...questionFields.map(q => q.header)];
    const parser = new Parser({ fields });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="event_${event.id}_responses.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error('Export responses CSV (admin) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});
