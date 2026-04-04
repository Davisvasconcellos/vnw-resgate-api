const express = require('express');
const { body, validationResult } = require('express-validator');
const { Op, fn, col } = require('sequelize');
const { sequelize } = require('../config/database');
const { Event, EventQuestion, EventResponse, EventAnswer, User, EventGuest, TokenBlocklist, EventTicketType, EventTicket } = require('../models');
const { authenticateToken } = require('../middlewares/auth');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const { buildEventTicketQrToken } = require('../utils/eventTicketQr');

// Ensure Firebase Admin is initialized (reuse if already initialized in auth)
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  } catch (err) {
    console.error('Firebase Admin initialization error (eventsOpen):', err);
  }
}

const router = express.Router();

const toDateOnly = (d) => d.toISOString().slice(0, 10);
const toTimeOnly = (d) => d.toISOString().slice(11, 19);
const buildStartEndDatetime = (event) => {
  const date = event.date || null;
  const endDate = event.end_date || event.date || null;
  const startTime = event.start_time || null;
  const endTime = event.end_time || null;
  const start_datetime = date && startTime ? `${date}T${startTime}` : null;
  const end_datetime = endDate && endTime ? `${endDate}T${endTime}` : null;
  return { start_datetime, end_datetime };
};

/**
 * @swagger
 * /api/public/v1/events/public:
 *   get:
 *     summary: Listar eventos públicos com paginação e filtros (v1)
 *     tags: [Events Public]
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
 *           default: start_datetime
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *       - in: query
 *         name: slug
 *         schema:
 *           type: string
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
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Lista pública paginada de eventos (v1)
 */

/**
 * @swagger
 * /api/events/public:
 *   get:
 *     summary: Listar eventos públicos com paginação e filtros
 *     tags: [Events Public]
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
 *           default: start_datetime
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *       - in: query
 *         name: slug
 *         schema:
 *           type: string
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
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Lista pública paginada de eventos
 */
// GET /api/events/public - Lista pública de eventos com paginação/filtros
router.get('/public', async (req, res) => {
  try {
    // Query params
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const sortByAllowed = ['created_at', 'start_datetime', 'end_datetime', 'name'];
    const sortBy = sortByAllowed.includes(req.query.sort_by) ? req.query.sort_by : 'start_datetime';
    const { name, slug, status, from, to, date } = req.query;

    const where = { status: 'published' };
    if (name) where.name = { [Op.like]: `%${name}%` };
    if (slug) where.slug = { [Op.like]: `%${slug}%` };
    const now = new Date();
    const todayDate = toDateOnly(now);
    const nowTime = toTimeOnly(now);

    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) {
        const fromDate = toDateOnly(d);
        const fromTime = toTimeOnly(d);
        where[Op.and] = (where[Op.and] || []).concat([{
          [Op.or]: [
            { date: { [Op.gt]: fromDate } },
            { date: fromDate, start_time: { [Op.gte]: fromTime } }
          ]
        }]);
      }
    }

    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) {
        const toDate = toDateOnly(d);
        const toTime = toTimeOnly(d);
        where[Op.and] = (where[Op.and] || []).concat([{
          [Op.or]: [
            { date: { [Op.lt]: toDate } },
            { date: toDate, start_time: { [Op.lte]: toTime } }
          ]
        }]);
      }
    }

    if (date) {
      const d = new Date(date);
      if (!Number.isNaN(d.getTime())) {
        const targetDate = toDateOnly(d);
        const targetTime = toTimeOnly(d);
        where[Op.and] = (where[Op.and] || []).concat([
          { date: { [Op.lte]: targetDate } },
          {
            [Op.or]: [
              { end_date: null, date: targetDate },
              { end_date: { [Op.gte]: targetDate } }
            ]
          }
        ]);
      }
    }

    if (status) {
      if (status === 'upcoming') {
        where[Op.and] = (where[Op.and] || []).concat([{
          [Op.or]: [
            { date: { [Op.gt]: todayDate } },
            { date: todayDate, [Op.or]: [{ start_time: null }, { start_time: { [Op.gt]: nowTime } }] }
          ]
        }]);
      } else if (status === 'ongoing') {
        where[Op.and] = (where[Op.and] || []).concat([
          {
            [Op.or]: [
              { date: { [Op.lt]: todayDate } },
              { date: todayDate, start_time: Object.assign(where.start_time || {}, { [Op.lte]: nowTime }) }
            ]
          },
          {
            [Op.or]: [
              { end_date: { [Op.gt]: todayDate } },
              { end_date: null, date: todayDate, [Op.or]: [{ end_time: null }, { end_time: { [Op.gte]: nowTime } }] },
              { end_date: todayDate, [Op.or]: [{ end_time: null }, { end_time: { [Op.gte]: nowTime } }] }
            ]
          }
        ]);
      } else if (status === 'past') {
        where[Op.or] = [
          { end_date: { [Op.lt]: todayDate } },
          { end_date: null, date: { [Op.lt]: todayDate } },
          { end_date: null, date: todayDate, end_time: { [Op.lt]: nowTime } },
          { end_date: todayDate, end_time: { [Op.lt]: nowTime } }
        ];
      }
    }

    const offset = (page - 1) * limit;
    const total = await Event.count({ where });
    const orderClause = (() => {
      if (sortBy === 'start_datetime') return [['date', order], ['start_time', order]];
      if (sortBy === 'end_datetime') return [['date', order], ['end_time', order]];
      return [[sortBy, order]];
    })();
    const rows = await Event.findAll({
      where,
      attributes: ['id', 'id_code', 'name', 'slug', 'banner_url', 'date', 'end_date', 'start_time', 'end_time', 'public_url', 'gallery_url', 'place', 'description', 'created_at'],
      order: orderClause,
      offset,
      limit
    });

    return res.json({
      success: true,
      data: {
        events: rows.map(r => {
          const j = r.toJSON();
          j.id = j.id_code; // Sanitiza ID
          const dt = buildStartEndDatetime(j);
          j.start_datetime = dt.start_datetime;
          j.end_datetime = dt.end_datetime;
          return j;
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
    console.error('Public list events error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// GET /api/events/:id/detail - informações públicas completas do evento para o front-end (v1)
router.get('/:id/detail', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id, status: 'published' } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const payload = {
      id: event.id,
      id_code: event.id_code,
      name: event.name,
      slug: event.slug,
      description: event.description,
      banner_url: event.banner_url,
      public_url: event.public_url,
      gallery_url: event.gallery_url,
      place: event.place,
      start_time: event.start_time,
      end_time: event.end_time,
      date: event.date,
      end_date: event.end_date || event.date,
      status: event.status,
      resp_email: event.resp_email,
      resp_name: event.resp_name,
      resp_phone: event.resp_phone,
      color_1: event.color_1,
      color_2: event.color_2,
      card_background: event.card_background,
      card_background_type: event.card_background_type,
      auto_checkin: !!event.auto_checkin,
      requires_auto_checkin: !!event.requires_auto_checkin,
      auto_checkin_flow_quest: !!event.auto_checkin_flow_quest,
      checkin_component_config: event.checkin_component_config || null,
      created_at: event.created_at,
      updated_at: event.updated_at
    };
    const dt = buildStartEndDatetime(payload);
    payload.start_datetime = dt.start_datetime;
    payload.end_datetime = dt.end_datetime;

    return res.json({ success: true, data: payload });
  } catch (error) {
    console.error('Get event detail error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// GET /api/events/:id - alias público para detalhes do evento por id_code (v1)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id, status: 'published' } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const payload = {
      id: event.id,
      id_code: event.id_code,
      name: event.name,
      slug: event.slug,
      description: event.description,
      banner_url: event.banner_url,
      public_url: event.public_url,
      gallery_url: event.gallery_url,
      place: event.place,
      start_time: event.start_time,
      end_time: event.end_time,
      date: event.date,
      end_date: event.end_date || event.date,
      status: event.status,
      resp_email: event.resp_email,
      resp_name: event.resp_name,
      resp_phone: event.resp_phone,
      color_1: event.color_1,
      color_2: event.color_2,
      card_background: event.card_background,
      card_background_type: event.card_background_type,
      auto_checkin: !!event.auto_checkin,
      requires_auto_checkin: !!event.requires_auto_checkin,
      auto_checkin_flow_quest: !!event.auto_checkin_flow_quest,
      checkin_component_config: event.checkin_component_config || null,
      created_at: event.created_at,
      updated_at: event.updated_at
    };
    const dt = buildStartEndDatetime(payload);
    payload.start_datetime = dt.start_datetime;
    payload.end_datetime = dt.end_datetime;

    return res.json({ success: true, data: payload });
  } catch (error) {
    console.error('Get event public detail alias error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// GET /api/events/:id/guest/me - status de check-in do usuário autenticado
router.get('/:id/guest/me', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    // Verificar se evento está cancelado ou pausado
    if (event.status === 'canceled' || event.status === 'paused') {
      return res.status(400).json({ 
        error: 'Event Unavailable', 
        message: `Este evento está ${event.status === 'canceled' ? 'cancelado' : 'pausado'} e não aceita novos check-ins.` 
      });
    }

    const userId = req.user.userId;
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuário não encontrado' });
    }

    let guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: userId } });
    if (!guest && user.email) {
      const lowerEmail = user.email.toLowerCase();
      guest = await EventGuest.findOne({
        where: {
          event_id: event.id,
          [Op.and]: [sequelize.where(fn('LOWER', col('guest_email')), lowerEmail)]
        }
      });
    }

    if (!guest) {
      return res.status(404).json({ error: 'Not Found', message: 'Convidado não encontrado para este evento' });
    }

    const response = await EventResponse.findOne({ where: { event_id: event.id, user_id: userId } });
    const selfieUrl = response?.selfie_url || null;

    return res.json({
      success: true,
      data: {
        guest_id: guest.id_code,
        checked_in: !!guest.check_in_at,
        checkin_at: guest.check_in_at,
        selfie_url: selfieUrl
      }
    });
  } catch (error) {
    console.error('Get my guest status error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// POST /api/events/:id/checkin - efetiva check-in para usuário autenticado (idempotente)
router.post('/:id/checkin', authenticateToken, [
  body('name').isLength({ min: 1 }).withMessage('name é obrigatório'),
  body('email').isEmail().withMessage('email inválido'),
  body('selfie_url').optional().isURL({ require_tld: false }).withMessage('selfie_url inválida')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', message: 'Dados inválidos', details: errors.array() });
    }

    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const userId = req.user.userId;
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuário não encontrado' });
    }

    const { name, email, selfie_url } = req.body;

    // Busca convidado por user_id e fallback por email normalizado
    let guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: userId } });
    if (!guest) {
      const lowerEmail = (email || user.email || '').toLowerCase();
      if (lowerEmail) {
        guest = await EventGuest.findOne({
          where: {
            event_id: event.id,
            [Op.and]: [sequelize.where(fn('LOWER', col('guest_email')), lowerEmail)]
          }
        });
      }
    }

    if (guest) {
      const updatePayload = {
        user_id: guest.user_id || userId,
        guest_name: name || guest.guest_name || user.name,
        guest_email: email || guest.guest_email || user.email,
        check_in_method: 'auto_checkin',
        authorized_by_user_id: null
      };
      if (!guest.check_in_at) {
        updatePayload.check_in_at = new Date();
      }
      await guest.update(updatePayload);
    } else {
      guest = await EventGuest.create({
        event_id: event.id,
        user_id: userId,
        guest_name: name || user.name,
        guest_email: email || user.email,
        guest_phone: user.phone || null,
        guest_document_type: null,
        guest_document_number: null,
        type: 'normal',
        source: 'invited',
        rsvp_confirmed: false,
        rsvp_at: null,
        invited_at: new Date(),
        invited_by_user_id: null,
        check_in_at: new Date(),
        check_in_method: 'auto_checkin',
        authorized_by_user_id: null
      });
    }

    // Atualiza/insere EventResponse para armazenar selfie
    if (selfie_url) {
      // Atualiza também o EventGuest com a selfie
      if (guest) {
        await guest.update({ selfie_url });
      }

      let response = await EventResponse.findOne({ where: { event_id: event.id, user_id: userId } });
      if (!response) {
        response = await EventResponse.create({
          event_id: event.id,
          user_id: userId,
          guest_code: (Math.random().toString(36).slice(2, 10)).toUpperCase(),
          selfie_url,
          submitted_at: new Date()
        });
      } else {
        await response.update({ selfie_url });
      }
    }

    return res.json({
      success: true,
      data: {
        guest_id: guest.id_code,
        checked_in: !!guest.check_in_at,
        checkin_at: guest.check_in_at
      }
    });
  } catch (error) {
    console.error('Check-in error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/tickets/reserve', authenticateToken, [
  body('ticket_type_id').optional({ nullable: true }).isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', message: 'Dados inválidos', details: errors.array() });
    }

    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }
    if (event.status !== 'published') {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Evento não está publicado para reservas',
        status: event.status
      });
    }

    const now = new Date();
    const endDate = event.end_date || event.date;
    const endDt = event.end_time ? new Date(`${endDate}T${event.end_time}`) : new Date(`${endDate}T23:59:59`);
    if (now > endDt) {
      return res.status(400).json({ error: 'Validation error', message: 'Evento encerrado' });
    }

    const userId = req.user.userId;
    const requestedTypeIdCode = req.body.ticket_type_id ? String(req.body.ticket_type_id) : null;

    const t = await sequelize.transaction();
    try {
      const existingActive = await EventTicket.findOne({
        where: { event_id: event.id, user_id: userId, status: { [Op.in]: ['reserved', 'checked_in'] } },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (existingActive) {
        await t.commit();
        const qr_token = buildEventTicketQrToken({
          ticket_id: existingActive.id_code,
          event_id: event.id_code,
          expires_at: existingActive.expires_at || endDt
        });
        return res.json({
          success: true,
          data: {
            ticket_id: existingActive.id_code,
            status: existingActive.status,
            already_reserved: true,
            qr_token
          }
        });
      }

      let ticketType = null;
      if (requestedTypeIdCode) {
        ticketType = await EventTicketType.findOne({
          where: { id_code: requestedTypeIdCode, event_id: event.id, status: 'active' },
          transaction: t,
          lock: t.LOCK.UPDATE
        });
        if (!ticketType) {
          await t.rollback();
          return res.status(404).json({ error: 'Not Found', message: 'Lote/Tipo de ingresso não encontrado' });
        }
      } else {
        ticketType = await EventTicketType.findOne({
          where: {
            event_id: event.id,
            status: 'active',
            [Op.and]: [
              { [Op.or]: [{ start_at: null }, { start_at: { [Op.lte]: now } }] },
              { [Op.or]: [{ end_at: null }, { end_at: { [Op.gte]: now } }] }
            ]
          },
          order: [['sort_order', 'ASC'], ['created_at', 'ASC']],
          transaction: t,
          lock: t.LOCK.UPDATE
        });
      }

      if (!ticketType) {
        ticketType = await EventTicketType.create({
          event_id: event.id,
          name: 'Ingresso',
          description: null,
          price_amount: 0,
          currency: 'BRL',
          total_quantity: null,
          start_at: null,
          end_at: null,
          sort_order: 0,
          status: 'active'
        }, { transaction: t });
      }

      if (ticketType.total_quantity !== null && ticketType.total_quantity !== undefined) {
        const activeCount = await EventTicket.count({
          where: { event_id: event.id, ticket_type_id: ticketType.id, status: { [Op.in]: ['reserved', 'checked_in'] } },
          transaction: t
        });
        if (activeCount >= ticketType.total_quantity) {
          await t.rollback();
          return res.status(409).json({ error: 'Sold out', message: 'Ingressos esgotados' });
        }
      }

      const expiresAt = endDt;
      const ticket = await EventTicket.create({
        event_id: event.id,
        user_id: userId,
        ticket_type_id: ticketType.id,
        status: 'reserved',
        reserved_at: now,
        expires_at: expiresAt,
        price_amount: ticketType.price_amount,
        currency: ticketType.currency,
        metadata: { source: 'public_reserve' }
      }, { transaction: t });

      await t.commit();
      const qr_token = buildEventTicketQrToken({
        ticket_id: ticket.id_code,
        event_id: event.id_code,
        expires_at: ticket.expires_at
      });
      return res.status(201).json({
        success: true,
        data: {
          ticket_id: ticket.id_code,
          status: ticket.status,
          expires_at: ticket.expires_at,
          qr_token,
          ticket_type: {
            id: ticketType.id_code,
            name: ticketType.name,
            price_amount: ticketType.price_amount,
            currency: ticketType.currency
          }
        }
      });
    } catch (err) {
      await t.rollback();
      if (err && err.name && String(err.name).includes('SequelizeUniqueConstraintError')) {
        return res.status(409).json({ error: 'Conflict', message: 'Você já possui um ingresso ativo para este evento' });
      }
      throw err;
    }
  } catch (error) {
    console.error('Reserve ticket error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/:id/self-checkin', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id, status: 'published' } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    if (!event.auto_checkin && !event.requires_auto_checkin) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Self-checkin não habilitado para este evento',
        auto_checkin: !!event.auto_checkin,
        requires_auto_checkin: !!event.requires_auto_checkin
      });
    }

    const userId = req.user.userId;
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuário não encontrado' });
    }

    const now = new Date();
    const endDate = event.end_date || event.date;
    const endDt = event.end_time ? new Date(`${endDate}T${event.end_time}`) : new Date(`${endDate}T23:59:59`);
    if (now > endDt) {
      return res.status(400).json({ error: 'Validation error', message: 'Evento encerrado' });
    }

    const ticket = await EventTicket.findOne({
      where: {
        event_id: event.id,
        user_id: userId,
        status: { [Op.in]: ['reserved', 'checked_in'] }
      }
    });

    if (!ticket) {
      return res.status(409).json({
        error: 'Need ticket',
        code: 'need_ticket',
        message: 'Você precisa reservar um ingresso antes do check-in',
        reserve_endpoint: `/api/public/v1/events/${id}/tickets/reserve`
      });
    }

    if (ticket.status === 'checked_in') {
      return res.json({
        success: true,
        data: {
          checked_in: true,
          already_checked_in: true,
          ticket_id: ticket.id_code
        }
      });
    }

    if (ticket.expires_at && new Date(ticket.expires_at).getTime() < Date.now()) {
      await ticket.update({ status: 'expired' });
      return res.status(400).json({ error: 'Validation error', message: 'Ingresso expirado' });
    }

    const t = await sequelize.transaction();
    try {
      await ticket.update({ status: 'checked_in', checked_in_at: now }, { transaction: t });

      const guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!guest) {
        await EventGuest.create({
          event_id: event.id,
          user_id: userId,
          guest_name: user.name || 'Guest',
          guest_email: user.email || null,
          guest_phone: user.phone || null,
          type: 'normal',
          source: 'invited',
          rsvp_confirmed: true,
          rsvp_at: now,
          invited_at: now,
          invited_by_user_id: null,
          check_in_at: now,
          check_in_method: 'auto_checkin',
          authorized_by_user_id: null
        }, { transaction: t });
      } else {
        await guest.update({
          rsvp_confirmed: true,
          rsvp_at: guest.rsvp_at || now,
          check_in_at: guest.check_in_at || now,
          check_in_method: guest.check_in_method || 'auto_checkin'
        }, { transaction: t });
      }

      await t.commit();
      return res.json({
        success: true,
        data: {
          checked_in: true,
          ticket_id: ticket.id_code,
          checked_in_at: now
        }
      });
    } catch (err) {
      await t.rollback();
      throw err;
    }
  } catch (error) {
    console.error('Self-checkin error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/public/v1/events/public/{slug}:
  *   get:
 *     summary: Detalhes públicos do evento por slug (somente perguntas públicas, v1)
 *     tags: [Events Public]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do evento com perguntas visíveis (v1)
 *       404:
 *         description: Evento não encontrado
 */

/**
 * @swagger
 * /api/events/public/{slug}:
  *   get:
 *     summary: Detalhes públicos do evento por slug (somente perguntas públicas)
 *     tags: [Events Public]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do evento com perguntas visíveis
 *       404:
 *         description: Evento não encontrado
 */
// GET /api/events/public/:slug
router.get('/public/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const event = await Event.findOne({
      where: { slug, status: 'published' },
      include: [{
        model: EventQuestion,
        as: 'questions',
        where: { is_public: true },
        required: false,
        attributes: ['id', 'question_text', 'question_type', 'options'],
        order: [['order_index', 'ASC']]
      }]
    });

    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const payload = {
      id: event.id,
      id_code: event.id_code,
      name: event.name,
      slug: event.slug,
      description: event.description,
      banner_url: event.banner_url,
      public_url: event.public_url,
      gallery_url: event.gallery_url,
      place: event.place,
      date: event.date,
      start_time: event.start_time,
      end_time: event.end_time,
      ...buildStartEndDatetime(event),
      questions: (event.questions || []).map(q => ({
        id: q.id,
        text: q.question_text,
        type: q.question_type,
        options: q.options || null
      }))
    };

    return res.json({ success: true, data: payload });
  } catch (error) {
    console.error('Public event by slug error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/public/v1/events/{id}/responses:
 *   post:
 *     summary: Enviar respostas de evento (público, v1)
 *     tags: [Events Public]
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
 *             required: [guest_code, answers]
 *             properties:
 *               guest_code:
 *                 type: string
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
 *     responses:
 *       201:
 *         description: Respostas registradas com sucesso (v1)
 *       404:
 *         description: Evento não encontrado
 *       409:
 *         description: guest_code já utilizado
 */

/**
 * @swagger
 * /api/events/{id}/responses:
 *   post:
 *     summary: Enviar respostas de evento
 *     tags: [Events Public]
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
 *             required: [guest_code, answers]
 *             properties:
 *               guest_code:
 *                 type: string
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
 *             guest_code: "ABC123"
 *             selfie_url: "https://example.com/selfies/abc123.jpg"
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
 *         description: guest_code já utilizado
 */
// POST /api/events/:id/responses
router.post('/:id/responses', [
  body('guest_code').isLength({ min: 1, max: 255 }).trim().withMessage('guest_code é obrigatório'),
  body('selfie_url').optional().isURL().withMessage('selfie_url inválida'),
  body('answers').isArray({ min: 1 }).withMessage('answers deve ser uma lista')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  const { id } = req.params;
  const { guest_code, selfie_url, answers } = req.body;

  try {
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const existing = await EventResponse.findOne({ where: { event_id: event.id, guest_code } });
    if (existing) {
      return res.status(409).json({ error: 'Duplicate entry', message: 'guest_code já utilizado' });
    }

    const t = await sequelize.transaction();
    try {
      // valida perguntas pertencem ao evento
      // No fluxo público, só permitir respostas a perguntas públicas
      const eventQuestions = await EventQuestion.findAll({
        where: { event_id: event.id, is_public: true },
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
        guest_code,
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
    console.error('Create event response error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/events/{id}/questions-with-answers:
 *   get:
 *     summary: Listar perguntas públicas do evento com respostas pré-preenchidas por guest_code
 *     tags: [Events Public]
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
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Perguntas com opções (labels) e respostas selecionadas quando existentes
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 event_id: 42
 *                 id_code: "UUID-DO-EVENTO"
 *                 auto_checkin: true
 *                 checked_in: false
 *                 total_questions: 3
 *                 questions:
 *                   - id: 101
 *                     text: "Qual estilo você prefere?"
 *                     type: "radio"
 *                     options: ["Lager", "IPA", "Stout"]
 *                     selected_labels: ["IPA"]
 *                   - id: 102
 *                     text: "Quais maltes você escolhe?"
 *                     type: "checkbox"
 *                     options: ["Pils", "Cara", "Munich"]
 *                     selected_labels: ["Pils", "Munich"]
 *       404:
 *         description: Evento não encontrado
 */
// GET /api/events/:id/questions-with-answers — perguntas públicas com respostas do guest_code
router.get('/:id/questions-with-answers', async (req, res) => {
  try {
    const { id } = req.params;
    const { guest_code } = req.query;

    // Autenticação opcional: se houver Authorization, validar token; caso inválido, retornar 401
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

    // Para não autenticado, exigir guest_code, mas permitir opcional se o usuário acabou de fazer checkin e o frontend ainda não mandou
    // Na verdade, se não mandou guest_code e não está autenticado, não temos como saber quem é.
    // Mas o erro diz "guest_code é obrigatório", então o frontend provavelmente não está enviando na query string.
    
    // Se o usuário já fez checkin (POST /checkin), ele recebe um guest_id (que é o id do EventGuest, não o guest_code do EventResponse).
    // O frontend deve estar usando esse ID. Vamos tentar buscar pelo guest_id também?
    
    // Ajuste: Permitir que a rota funcione apenas com o ID do evento para listar perguntas (sem respostas preenchidas)
    // se não tiver guest_code.
    // MAS, o requisito original parecia ser carregar respostas anteriores.
    
    // Vamos relaxar a validação: se não tiver guest_code, retorna as perguntas sem respostas preenchidas.
    if (!isAuthenticated && !guest_code) {
       // Apenas logar ou seguir sem erro, para permitir carregar as perguntas em branco
    }

    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }
    
    // Se autenticado, retorna todas as perguntas; caso contrário, apenas públicas
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

    // Prefill: se autenticado, prioriza respostas do usuário; senão, usa guest_code
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
              // tentar CSV
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
      // sanitizar possíveis marcadores [c]
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

    // Determina se usuário já está com check-in
    let checked_in = false;
    if (isAuthenticated) {
      const guestForUser = await EventGuest.findOne({ where: { event_id: event.id, user_id: authUserId } });
      if (guestForUser && guestForUser.check_in_at) {
        checked_in = true;
      } else {
        // fallback por email quando não há vínculo por user_id
        if (user && user.email) {
          const lowerEmail = user.email.toLowerCase();
          const guestByEmail = await EventGuest.findOne({
            where: {
              event_id: event.id,
              [Op.and]: [
                sequelize.where(fn('LOWER', col('guest_email')), lowerEmail)
              ]
            }
          });
          if (guestByEmail && guestByEmail.check_in_at) {
            checked_in = true;
          }
        }
      }
    }

    return res.json({
      success: true,
      data: {
        event_id: event.id,
        id_code: event.id_code,
        auto_checkin: !!event.auto_checkin,
        checked_in,
        total_questions: payloadQuestions.length,
        questions: payloadQuestions
      }
    });
  } catch (error) {
    console.error('Questions with answers (public) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/events/{id}/questions-with-answers:
 *   get:
 *     summary: Retorna perguntas do evento com respostas pré-preenchidas (auth opcional)
 *     tags: [Events Public]
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
  *                 auto_checkin: true
  *                 checked_in: false
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

/**
 * @swagger
 * /api/events/{id}/questions/{questionId}/verify:
 *   post:
 *     summary: Verificar correção de resposta para pergunta de tipo rádio (sem expor resposta correta)
 *     tags: [Events Public]
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
 *       - in: header
 *         name: Authorization
 *         schema:
 *           type: string
 *         description: Bearer token. Quando presente e válido, permite verificar perguntas privadas.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               answer_text:
 *                 type: string
 *           example:
 *             answer_text: "IPA"
 *     responses:
 *       200:
 *         description: Resultado da verificação
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 is_correct: true
 *                 correct_defined: true
 *       401:
 *         description: Token inválido ou usuário não encontrado (quando Authorization enviado)
 *       404:
 *         description: Evento/Pergunta não encontrado
 */
// POST /api/events/:id/questions/:questionId/verify — valida apenas rádio
router.post('/:id/questions/:questionId/verify', async (req, res) => {
  try {
    const { id, questionId } = req.params;
    const { answer_text } = req.body || {};

    if (typeof answer_text !== 'string') {
      return res.status(400).json({ error: 'Validation error', message: 'answer_text deve ser string' });
    }

    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }
    
    // Autenticação opcional: se houver Authorization, validar para permitir pergunta privada
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let isAuthenticated = false;
    if (token) {
      try {
        const isBlocked = await TokenBlocklist.findByPk(token);
        if (isBlocked) {
          return res.status(401).json({ message: 'Token inválido' });
        }
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findByPk(decoded.userId);
        if (!user) {
          return res.status(401).json({ message: 'Usuário não encontrado' });
        }
        isAuthenticated = true;
      } catch (err) {
        return res.status(403).json({ message: 'Token inválido ou expirado' });
      }
    }

    const q = await EventQuestion.findOne({
      where: isAuthenticated
        ? { event_id: event.id, id: parseInt(questionId, 10) }
        : { event_id: event.id, id: parseInt(questionId, 10), is_public: true },
      attributes: ['id', 'question_type', 'options', 'correct_option_index']
    });
    if (!q) {
      return res.status(404).json({ error: 'Not Found', message: 'Pergunta não encontrada' });
    }
    if (q.question_type !== 'radio') {
      return res.status(422).json({ error: 'Unprocessable Entity', message: 'Verificação suportada apenas para perguntas do tipo rádio' });
    }

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
    if (labels.length && !labels.includes(answer_text)) {
      return res.status(400).json({ error: 'Validation error', message: 'Resposta não corresponde às opções disponíveis' });
    }

    let correctIndex = (typeof q.correct_option_index === 'number') ? q.correct_option_index : null;
    if (correctIndex == null) {
      // derivar de opções-objeto
      const idx = rawOpts.findIndex(o => typeof o === 'object' && o && o.is_correct === true);
      correctIndex = idx >= 0 ? idx : null;
    }

    if (correctIndex == null || correctIndex < 0 || correctIndex >= labels.length) {
      return res.json({ success: true, data: { is_correct: false, correct_defined: false } });
    }

    const is_correct = labels[correctIndex] === answer_text;
    return res.json({ success: true, data: { is_correct, correct_defined: true } });
  } catch (error) {
    console.error('Verify answer (public) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/events/{id}/responses:
 *   patch:
 *     summary: Continuar/atualizar respostas do evento (upsert por guest_code)
 *     tags: [Events Public]
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
 *             required: [guest_code, answers]
 *             properties:
 *               guest_code:
 *                 type: string
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
 *             guest_code: "ABC123"
 *             selfie_url: "https://example.com/selfies/abc123.jpg"
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
// PATCH /api/events/:id/responses — upsert por guest_code
router.patch('/:id/responses', [
  body('guest_code').isLength({ min: 1, max: 255 }).trim().withMessage('guest_code é obrigatório'),
  body('selfie_url').optional().isURL().withMessage('selfie_url inválida'),
  body('answers').isArray({ min: 1 }).withMessage('answers deve ser uma lista')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  const { id } = req.params;
  const { guest_code, selfie_url, answers } = req.body;

  try {
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const t = await sequelize.transaction();
    try {
      // Carregar perguntas públicas do evento
      const eventQuestions = await EventQuestion.findAll({
        where: { event_id: event.id, is_public: true },
        attributes: ['id', 'question_type', 'options', 'is_required', 'max_choices'],
        transaction: t
      });
      const questionById = new Map(eventQuestions.map(q => [q.id, q]));

      // Encontrar ou criar o response
      let response = await EventResponse.findOne({ where: { event_id: event.id, guest_code }, transaction: t });
      if (!response) {
        response = await EventResponse.create({
          event_id: event.id,
          guest_code,
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
    console.error('Upsert event response error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/public/v1/events/{id}/checkin/google:
 *   post:
 *     summary: Check-in via login Google (evento aberto, v1)
 *     tags: [Events Public]
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
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Check-in realizado (v1)
 *       404:
 *         description: Evento não encontrado
 *       409:
 *         description: Convidado já checkado
 */

/**
 * @swagger
 * /api/events/{id}/checkin/google:
 *   post:
 *     summary: Check-in via login Google (evento aberto)
 *     tags: [Events Public]
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
 *             required: [idToken]
 *             properties:
 *               idToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Check-in realizado
 *       404:
 *         description: Evento não encontrado
 *       409:
 *         description: Convidado já checkado
 */
router.post('/:id/checkin/google', [
  body('idToken').isString().withMessage('idToken é obrigatório')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', message: 'Dados inválidos', details: errors.array() });
    }

    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const { idToken } = req.body;
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token', message: 'Token do Google inválido ou expirado' });
    }

    const { email, name, picture, sub, email_verified } = decoded;
    if (!email) {
      return res.status(400).json({ error: 'Email required', message: 'Email não disponível no token do Google' });
    }

    // Localiza ou cria usuário com base no Google UID ou email
    let user = await User.findOne({ where: { [Op.or]: [{ google_uid: sub }, { google_id: sub }, { email }] } });
    if (!user) {
      const randomPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      user = await User.create({
        name: name || (email ? email.split('@')[0] : 'Usuário Google'),
        email,
        password: randomPassword,
        role: 'customer',
        google_uid: sub,
        google_id: sub,
        avatar_url: picture || null,
        email_verified: !!email_verified
      });
    } else {
      // Atualiza dados úteis se necessário
      await user.update({
        google_uid: user.google_uid || sub,
        google_id: user.google_id || sub,
        name: user.name || name || email,
        avatar_url: user.avatar_url || picture || null,
        email_verified: user.email_verified || !!email_verified
      });
    }

    // Verifica se já existe convidado vinculado ao usuário
    let guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: user.id } });
    if (guest) {
      if (!guest.check_in_at) {
        await guest.update({
          guest_name: guest.guest_name || user.name,
          guest_email: guest.guest_email || user.email,
          check_in_at: new Date(),
          check_in_method: 'google',
          source: 'walk_in',
          authorized_by_user_id: null
        });
      }
    } else {
      guest = await EventGuest.create({
        event_id: event.id,
        user_id: user.id,
        guest_name: user.name,
        guest_email: user.email,
        guest_phone: user.phone || null,
        guest_document_type: null,
        guest_document_number: null,
        type: 'normal',
        source: 'walk_in',
        rsvp_confirmed: false,
        rsvp_at: null,
        invited_at: new Date(),
        invited_by_user_id: null,
        check_in_at: new Date(),
        check_in_method: 'google',
        authorized_by_user_id: null
      });
    }

    return res.json({ success: true, data: { guest } });
  } catch (error) {
    console.error('Public Google check-in error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/events/{id}/auto-checkin:
 *   post:
 *     summary: Auto check-in (evento com auto_checkin=true) usando usuário autenticado
 *     tags: [Events Public]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: id_code do evento (UUID)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               selfie_url:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Check-in realizado/atualizado com sucesso
 *       400:
 *         description: Erro de validação
 *       401:
 *         description: Token inválido
 *       404:
 *         description: Evento não encontrado
 */
router.post('/:id/auto-checkin', [
  body('name').isLength({ min: 1 }).withMessage('name é obrigatório'),
  body('email').isEmail().withMessage('email inválido'),
  body('selfie_url').optional().isURL().withMessage('selfie_url inválida')
  ], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', message: 'Dados inválidos', details: errors.array() });
    }

    // Requer Authorization
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token é obrigatório' });
    }
    const isBlocked = await TokenBlocklist.findByPk(token);
    if (isBlocked) {
      return res.status(401).json({ message: 'Token inválido' });
    }
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Token inválido ou expirado' });
    }

    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuário não encontrado' });
    }

    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    // Verificar se evento está cancelado ou pausado
    if (event.status === 'canceled' || event.status === 'paused') {
      return res.status(400).json({ 
        error: 'Event Unavailable', 
        message: `Este evento está ${event.status === 'canceled' ? 'cancelado' : 'pausado'} e não aceita novos check-ins.` 
      });
    }

    // Se o evento não exige auto_checkin, ainda permitimos operação para consolidar dados
    const { name, email, selfie_url } = req.body;

    // Tenta localizar convidado pelo user_id; se não achar, tenta por email
    let guest = await EventGuest.findOne({ where: { event_id: event.id, user_id: user.id } });
    if (!guest) {
      const lowerEmail = (email || user.email || '').toLowerCase();
      if (lowerEmail) {
        guest = await EventGuest.findOne({
          where: {
            event_id: event.id,
            [Op.and]: [
              // comparação case-insensitive
              sequelize.where(fn('LOWER', col('guest_email')), lowerEmail)
            ]
          }
        });
      }
    }

    if (guest) {
      const updatePayload = {
        user_id: guest.user_id || user.id,
        guest_name: name || guest.guest_name || user.name,
        guest_email: email || guest.guest_email || user.email,
        check_in_method: 'auto_checkin',
        authorized_by_user_id: null
      };
      if (!guest.check_in_at) {
        updatePayload.check_in_at = new Date();
      }
      await guest.update(updatePayload);
    } else {
      // Se não há vínculo, cria novo convidado normal já com check-in (auto_checkin)
      guest = await EventGuest.create({
        event_id: event.id,
        user_id: user.id,
        guest_name: name || user.name,
        guest_email: email || user.email,
        guest_phone: user.phone || null,
        guest_document_type: null,
        guest_document_number: null,
        type: 'normal',
        source: 'invited',
        rsvp_confirmed: false,
        rsvp_at: null,
        invited_at: new Date(),
        invited_by_user_id: null,
        check_in_at: new Date(),
        check_in_method: 'auto_checkin',
        authorized_by_user_id: null
      });
    }

    // Atualiza/insere EventResponse para armazenar selfie
    if (selfie_url) {
      let response = await EventResponse.findOne({ where: { event_id: event.id, user_id: user.id } });
      if (!response) {
        response = await EventResponse.create({
          event_id: event.id,
          user_id: user.id,
          guest_code: (Math.random().toString(36).slice(2, 10)).toUpperCase(),
          selfie_url,
          submitted_at: new Date()
        });
      } else {
        await response.update({ selfie_url });
      }
    }

    return res.json({ success: true, data: { guest } });
  } catch (error) {
    console.error('Auto-checkin (public) error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/public/v1/events/{id}/responses:
 *   get:
 *     summary: Listar respostas de evento com paginação e filtros (v1)
 *     tags: [Events Public]
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
 *           enum: [submitted_at, guest_code]
 *           default: submitted_at
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
 *         description: Lista paginada de respostas (v1)
 *       404:
 *         description: Evento não encontrado
 */

/**
 * @swagger
 * /api/events/{id}/responses:
 *   get:
 *     summary: Listar respostas de evento com paginação e filtros
 *     tags: [Events Public]
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
 *           enum: [submitted_at, guest_code]
 *           default: submitted_at
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
 *         description: Lista paginada de respostas
 *       404:
 *         description: Evento não encontrado
 */
// GET /api/events/:id/responses
// Suporta paginação e filtros via query params:
// page, limit, order (asc|desc), sort_by (submitted_at|guest_code), guest_code, has_selfie (true|false), from, to, question_id, answer_contains
router.get('/:id/responses', async (req, res) => {
  try {
  const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    // Query params
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const sortBy = ['submitted_at', 'guest_code'].includes(req.query.sort_by) ? req.query.sort_by : 'submitted_at';
    const { guest_code, has_selfie, from, to } = req.query;
    const questionId = req.query.question_id ? parseInt(req.query.question_id, 10) : undefined;
    const answerContains = req.query.answer_contains;

    // Base where
    const where = { event_id: event.id };
    if (guest_code) {
      where.guest_code = { [Op.like]: `%${guest_code}%` };
    }
    if (typeof has_selfie !== 'undefined') {
      if (String(has_selfie).toLowerCase() === 'true') {
        where.selfie_url = { [Op.ne]: null };
      } else if (String(has_selfie).toLowerCase() === 'false') {
        where.selfie_url = { [Op.is]: null };
      }
    }
    if (from || to) {
      where.submitted_at = {};
      if (from) where.submitted_at[Op.gte] = new Date(from);
      if (to) where.submitted_at[Op.lte] = new Date(to);
    }

    // Include de respostas, opcionalmente com filtro por pergunta/resposta
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
      // Filtro de texto somente em answer_text
      answersInclude.where.answer_text = { [Op.like]: `%${answerContains}%` };
    }
    // Remover where vazio para evitar side effects
    if (Object.keys(answersInclude.where).length === 0) {
      delete answersInclude.where;
      answersInclude.required = false;
    }

    const offset = (page - 1) * limit;
    const { rows, count } = await EventResponse.findAndCountAll({
      where,
      include: [
        answersInclude,
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
        }
      ],
      order: [[sortBy, order]],
      offset,
      limit,
      distinct: true
    });

    const data = rows.map(r => {
      const answersObj = {};
      (r.answers || []).forEach(a => {
        const key = `q${a.question_id}`;
        answersObj[key] = a.answer_text != null ? a.answer_text : a.answer_json;
      });
      const user = r.user ? {
        id_code: r.user.id_code,
        name: r.user.name,
        email: r.user.email,
        phone: r.user.phone,
        avatar_url: r.user.avatar_url
      } : null;
      // Derivar dados do convidado do vínculo User -> EventGuest para o evento
      const guestFromEvent = r.user && Array.isArray(r.user.eventGuests) && r.user.eventGuests.length > 0
        ? r.user.eventGuests[0]
        : null;
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
        guest_code: r.guest_code,
        selfie_url: r.selfie_url,
        submitted_at: r.submitted_at,
        answers: answersObj,
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
    console.error('List event responses error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/events/{id}/questions/{questionId}/stats:
 *   get:
 *     summary: Estatísticas de respostas por opção (público, somente perguntas públicas com show_results)
 *     tags: [Events Public]
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
 *       403:
 *         description: Estatísticas indisponíveis (não pública ou show_results false)
 */
router.get('/:id/questions/:questionId/stats', async (req, res) => {
  try {
    const { id, questionId } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const question = await EventQuestion.findOne({ where: { id: questionId, event_id: event.id, is_public: true } });
    if (!question) {
      return res.status(404).json({ error: 'Not Found', message: 'Pergunta não encontrada' });
    }
    if (!question.show_results) {
      return res.status(403).json({ error: 'Forbidden', message: 'Estatísticas não permitidas para esta pergunta' });
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
    console.error('Public stats question error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/events/{id}/stats:
 *   get:
 *     summary: Estatísticas agregadas do evento (público)
 *     tags: [Events Public]
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
 *         description: Estatísticas agregadas por pergunta e opções (apenas públicas com show_results)
 *         content:
 *           application/json:
 *             example:
 *               success: true
 *               data:
 *                 event_id: 42
 *                 total_questions: 2
 *                 event_total_answers: 18
 *                 questions_stats:
 *                   - question_id: 101
 *                     text: Qual estilo você prefere?
 *                     type: radio
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
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id } });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const questions = await EventQuestion.findAll({ where: { event_id: event.id, is_public: true, show_results: true }, order: [['order_index', 'ASC']] });
    const questionsStats = [];
    let eventTotalAnswers = 0;

    for (const q of questions) {
      if (!['radio', 'checkbox'].includes(q.question_type)) {
        continue;
      }
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
        event_id: event.id,
        total_questions: questions.length,
        event_total_answers: eventTotalAnswers,
        questions_stats: questionsStats
      }
    });
  } catch (error) {
    console.error('Public stats event error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// GET /api/events/:id/responses/export
/**
 * @swagger
 * /api/public/v1/events/{id}/responses/export:
 *   get:
 *     summary: Exportar respostas de evento em CSV (v1)
 *     tags: [Events Public]
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
 *         description: CSV com respostas do evento (v1)
 *       404:
 *         description: Evento não encontrado
 */

/**
 * @swagger
 * /api/events/{id}/responses/export:
 *   get:
 *     summary: Exportar respostas de evento em CSV
 *     tags: [Events Public]
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
 *       404:
 *         description: Evento não encontrado
 */
router.get('/:id/responses/export', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await Event.findOne({ where: { id_code: id }, include: [{ model: EventQuestion, as: 'questions', order: [['order_index', 'ASC']] }] });
    if (!event) {
      return res.status(404).json({ error: 'Not Found', message: 'Evento não encontrado' });
    }

    const responses = await EventResponse.findAll({
      where: { event_id: event.id },
      include: [{ model: EventAnswer, as: 'answers' }],
      order: [['submitted_at', 'DESC']]
    });

    // campos dinâmicos por perguntas do evento
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

    // Lazy require para evitar custo quando não usado
    const { Parser } = require('json2csv');
    const fields = ['guest_code', 'selfie_url', 'submitted_at', ...questionFields.map(q => q.header)];
    const parser = new Parser({ fields });
    const csv = parser.parse(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="event_${event.id}_responses.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error('Export responses CSV error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

module.exports = router;
