const express = require('express');
const router = express.Router();
const { sequelize, HelpRequest, User, Shelter, ShelterVolunteer } = require('../models');
const { authenticateToken } = require('../middlewares/auth');
const { Op } = require('sequelize');

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
    const { device_id, type } = data;

    // 1. Verificação de Flood (Duplicate Prevention)
    if (device_id && type && !req.user) { // Libera múltiplos para usuários logados se quiserem, mas anônimo trava
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      const existingRequest = await HelpRequest.findOne({
        where: {
          device_id,
          type,
          status: 'pending',
          created_at: { [Op.gt]: twentyMinutesAgo }
        }
      });

      if (existingRequest) {
        return res.status(429).json({
          success: false,
          message: 'Você já tem uma solicitação deste tipo pendente. Por favor, aguarde o atendimento ou atualize a anterior.',
          id_code: existingRequest.id_code
        });
      }
    }
    
    if (req.user) {
      data.user_id = req.user.userId;
      data.is_verified = true;
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
    const { type, status, lat, lng, radiusKm = 10, limit = 50, offset = 0, id_codes } = req.query;
    const whereClause = {};

    if (type) whereClause.type = type;
    
    if (id_codes) {
      const codes = id_codes.split(',');
      whereClause.id_code = { [Op.in]: codes };
      // Se busca IDs específicos, não filtramos status
    } else if (status) {
      whereClause.status = status;
    } else {
      // Por padrão, oculta os já resolvidos para não poluir o mapa
      whereClause.status = { [Op.ne]: 'resolved' };
    }

    let order = [['created_at', 'DESC']];
    let attributes = { include: [] };

    // Fórmula Haversine se lat e lng estiverem presentes
    if (lat && lng) {
      const latFloat = parseFloat(lat);
      const lngFloat = parseFloat(lng);
      
      const haversine = `(
        6371 * acos(
          LEAST(1, GREATEST(-1, 
            cos(radians(${latFloat}))
            * cos(radians("HelpRequest"."lat"))
            * cos(radians("HelpRequest"."lng") - radians(${lngFloat}))
            + sin(radians(${latFloat}))
            * sin(radians("HelpRequest"."lat"))
          ))
        )
      )`;
      
      attributes.include.push([sequelize.literal(haversine), 'distance']);
      // Ordenar por mais próximo
      order = [[sequelize.literal('distance'), 'ASC']];
      whereClause[Op.and] = sequelize.where(sequelize.literal(haversine), '<=', parseFloat(radiusKm));
    }

    const { rows, count } = await HelpRequest.findAndCountAll({
      where: whereClause,
      attributes,
      include: [
        { model: User, as: 'requester', attributes: ['name', 'phone'] },
        { model: User, as: 'volunteer', attributes: ['name', 'phone'] },
        { model: Shelter, as: 'shelter', attributes: ['id_code', 'name', 'phone'] }
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
        { model: User, as: 'volunteer', attributes: ['name', 'phone'] },
        { model: Shelter, as: 'shelter', attributes: ['id_code', 'name', 'phone'] }
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
    const { status, volunteer_message, dropoff } = req.body;
    const request = await HelpRequest.findOne({ where: { id_code: req.params.id_code } });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
    }

    // Se o status for attending, cria o vínculo na equipe e valida os slots
    if (status === 'attending' && req.user) {
      // Se for um pedido de voluntário vinculado a um abrigo
      if (request.type === 'volunteer' && request.shelter_id) {
        // Verificar se o usuário já aceitou este convite
        const alreadyLinked = await ShelterVolunteer.findOne({
          where: { user_id: req.user.userId, help_request_id: request.id }
        });
        
        if (alreadyLinked) {
          return res.status(400).json({ success: false, message: 'Você já aceitou este convite' });
        }

        // Verificar slots disponíveis
        const acceptedCount = await ShelterVolunteer.count({
          where: { help_request_id: request.id }
        });

        if (acceptedCount >= request.total_slots) {
          return res.status(400).json({ success: false, message: 'Desculpe, todas as vagas já foram preenchidas' });
        }

        // Criar o registro na equipe
        await ShelterVolunteer.create({
          user_id: req.user.userId,
          shelter_id: request.shelter_id,
          help_request_id: request.id,
          status: 'accepted'
        });

        // Se preencheu a última vaga, podemos mudar o status do convite pai?
        // Na visão do user, se preencheu, ele não deve mais ver.
        if (acceptedCount + 1 >= request.total_slots) {
          request.status = 'attending'; // Indica que começou a ser atendido plenamente
        }
      } else {
        // Logica legada para pedidos individuais
        request.accepted_by = req.user.userId;
      }
      
      if (volunteer_message) {
        request.volunteer_message = volunteer_message;
      }
    }

    // Se estiver sendo finalizado (aceita 'resolved' ou 'completed')
    if (status === 'resolved' || status === 'completed') {
      request.finished_at = new Date();
      if (dropoff) {
        request.dropoff_location = dropoff;
      }
      request.status = 'resolved'; // Padroniza no banco
    } else {
      request.status = status || request.status;
    }

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
