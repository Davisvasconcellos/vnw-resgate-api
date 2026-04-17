const express = require('express');
const router = express.Router();
const { sequelize, HelpRequest, User } = require('../models');
const { authenticateToken } = require('../middlewares/auth');

// Função auxiliar opcional para extrair token sem bloquear se não estiver logado
const optionalAuth = (req, res, next) => {
  authenticateToken(req, res, () => next());
  // authenticateToken já lida com erro, mas se quisermos permitir publicos,
  // idealmente o authenticateToken ou bloqueia ou a gente checa os headers manuais.
  // Para ficar aderente às regras atuais, manteremos o fluxo público sem token e se tiver token ele usa.
};

/**
 * Helper para pegar usuário se houver token (cidadão) ou seguir sem erro se for visitante
 */
const extractUserIfExists = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return next();
  try {
    // Reutilizar o middleware de auth seria o ideal, mas vamos interceptar para não bloquear o fluxo público
    await new Promise((resolve) => {
       authenticateToken(req, res, () => resolve());
    });
    next();
  } catch (e) {
    next(); // ignorar erro de token invalido e deixar anonimo
  }
};

/**
 * POST /api/v1/requests
 * Criar novo pedido de ajuda. (Aberto ao público)
 */
router.post('/', extractUserIfExists, async (req, res) => {
  try {
    const data = req.body;
    
    if (req.user) {
      data.user_id = req.user.id;
    }

    const request = await HelpRequest.create(data);
    
    return res.status(201).json({
      success: true,
      message: 'Pedido de ajuda criado com sucesso.',
      data: request
    });
  } catch (error) {
    console.error('Error creating help request:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/requests
 * Listar pedidos (com filtros por tipo, status e proximidade/lat-lng).
 */
router.get('/', async (req, res) => {
  try {
    const { type, status, lat, lng, radiusKm = 10, limit = 50, offset = 0 } = req.query;
    const whereClause = {};

    if (type) whereClause.type = type;
    if (status) whereClause.status = status;

    let order = [['created_at', 'DESC']];
    let attributes = { include: [] };

    // Fórmula Haversine se lat e lng estiverem presentes
    if (lat && lng) {
      const haversine = `(
        6371 * acos(
          cos(radians(${sequelize.escape(lat)}))
          * cos(radians(lat))
          * cos(radians(lng) - radians(${sequelize.escape(lng)}))
          + sin(radians(${sequelize.escape(lat)}))
          * sin(radians(lat))
        )
      )`;
      
      attributes.include.push([sequelize.literal(haversine), 'distance']);
      // Ordenar por mais próximo
      order = [[sequelize.literal('distance'), 'ASC']];
      whereClause[sequelize.Op.and] = sequelize.where(sequelize.literal(haversine), '<=', parseFloat(radiusKm));
    }

    const { rows, count } = await HelpRequest.findAndCountAll({
      where: whereClause,
      attributes,
      include: [
        { model: User, as: 'requester', attributes: ['name', 'phone'] },
        { model: User, as: 'volunteer', attributes: ['name', 'phone'] }
      ],
      order,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });

    return res.status(200).json({
      success: true,
      data: rows,
      total: count,
      page: Math.floor(offset / limit) + 1,
      totalPages: Math.ceil(count / limit)
    });
  } catch (error) {
    console.error('Error fetching help requests:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/requests/:id_code
 * Detalhes do pedido.
 */
router.get('/:id_code', async (req, res) => {
  try {
    const request = await HelpRequest.findOne({
      where: { id_code: req.params.id_code },
      include: [
        { model: User, as: 'requester', attributes: ['name', 'phone'] },
        { model: User, as: 'volunteer', attributes: ['name', 'phone'] }
      ]
    });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
    }

    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    console.error('Error fetching help request detail:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * PUT /api/v1/requests/:id_code/status
 * Atualizar status (ex: aceitar pedido).
 * (Requer autenticação de voluntário/motorista/barqueiro)
 */
router.put('/:id_code/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const request = await HelpRequest.findOne({ where: { id_code: req.params.id_code } });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
    }

    // Se o status for attending, marca quem é o voluntário (se apropriado)
    if (status === 'attending' && req.user) {
      request.accepted_by = req.user.id;
    }

    request.status = status || request.status;
    await request.save();

    return res.status(200).json({
      success: true,
      message: 'Status atualizado',
      data: request
    });
  } catch (error) {
    console.error('Error updating request status:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

module.exports = router;
