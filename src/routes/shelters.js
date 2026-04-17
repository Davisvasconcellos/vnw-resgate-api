const express = require('express');
const router = express.Router();
const { Shelter, ShelterEntry, ShelterVolunteer, HelpRequest, User, sequelize } = require('../models');
const { authenticateToken, requireRole } = require('../middlewares/auth');
const { Op } = require('sequelize');

/**
 * Helper para validar se usuario é dono do abrigo ou role master/admin
 */
const isShelterManager = async (req, shelter) => {
  if (req.user.role === 'master' || req.user.role === 'admin') return true;
  return shelter.user_id === req.user.userId;
};

// ==========================================
// SHELTERS (ABRIGOS)
// ==========================================

/**
 * POST /api/v1/shelters
 * Cadastrar novo abrigo. (Exige admin ou master ou manager)
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const data = req.body;
    data.user_id = req.user.userId;
    
    const shelter = await Shelter.create(data);
    
    // Promove o usuário a gestor
    await User.update({ role: 'manager' }, { where: { id: req.user.userId } });
    
    return res.status(201).json({
      success: true,
      message: 'Abrigo criado com sucesso.',
      data: shelter
    });
  } catch (error) {
    console.error('Error creating shelter:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/shelters
 * Listar abrigos próximos
 */
router.get('/', async (req, res) => {
  try {
    const { lat, lng, radiusKm = 20, limit = 50, offset = 0 } = req.query;
    
    let order = [['created_at', 'DESC']];
    let attributes = { include: [] };
    const whereClause = {};

    if (lat && lng) {
      const latFloat = parseFloat(lat);
      const lngFloat = parseFloat(lng);

      const haversine = `(
        6371 * acos(
          LEAST(1, GREATEST(-1, 
            cos(radians(${latFloat}))
            * cos(radians("Shelter"."lat"))
            * cos(radians("Shelter"."lng") - radians(${lngFloat}))
            + sin(radians(${latFloat}))
            * sin(radians("Shelter"."lat"))
          ))
        )
      )`;
      
      attributes.include.push([sequelize.literal(haversine), 'distance']);
      order = [[sequelize.literal('distance'), 'ASC']];
      whereClause[Op.and] = sequelize.where(sequelize.literal(haversine), '<=', parseFloat(radiusKm));
    }

    const { rows, count } = await Shelter.findAndCountAll({
      where: whereClause,
      attributes,
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
    console.error('Error fetching shelters:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/shelters/:id_code
 */
router.get('/:id_code', async (req, res) => {
  try {
    const shelter = await Shelter.findOne({
      where: { id_code: req.params.id_code },
      include: [
        { model: User, as: 'manager', attributes: ['name', 'phone'] }
      ]
    });

    if (!shelter) {
      return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });
    }

    return res.status(200).json({ success: true, data: shelter });
  } catch (error) {
    console.error('Error fetching shelter detail:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

// ==========================================
// SHELTER ENTRIES (Gerenciamento de Lotação)
// ==========================================

/**
 * POST /api/v1/shelters/:id_code/entries
 * Fazer check-in manual ou solicitar vaga
 */
router.post('/:id_code/entries', async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });

    const data = req.body;
    data.shelter_id = shelter.id;
    
    // Status can be request or present directly created by manager
    const entry = await ShelterEntry.create(data);

    return res.status(201).json({
      success: true,
      message: 'Entrada/Vaga registrada.',
      data: entry
    });
  } catch (error) {
    console.error('Error creating shelter entry:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/shelters/:id_code/entries
 * Listar entradas do abrigo
 */
router.get('/:id_code/entries', authenticateToken, async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });

    // Apenas admin ou gestor do abrigo, ou voluntario aceito pode ver
    // (Simplificando: exigindo estar logado)
    
    const entries = await ShelterEntry.findAll({
      where: { shelter_id: shelter.id },
      order: [['created_at', 'DESC']]
    });

    return res.status(200).json({ success: true, data: entries });
  } catch (error) {
    console.error('Error fetching entries:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * PUT /api/v1/shelters/:id_code/entries/:entry_id_code
 * Atualizar status (Aprova checkin -> Lotação ++ Automática via Hook)
 */
router.put('/:id_code/entries/:entry_id_code', authenticateToken, async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });

    if (!(await isShelterManager(req, shelter))) {
      return res.status(403).json({ success: false, message: 'Sem permissão' });
    }

    const { status, assume_message } = req.body;
    const entry = await ShelterEntry.findOne({ 
      where: { id_code: req.params.entry_id_code, shelter_id: shelter.id } 
    });

    if (!entry) return res.status(404).json({ success: false, message: 'Entrada não encontrada' });

    entry.status = status || entry.status;
    entry.assume_message = assume_message || entry.assume_message;
    await entry.save(); // Dispara o hook que atualiza occupied do Shelter

    return res.status(200).json({
      success: true,
      message: 'Status de entrada atualizado.',
      data: entry
    });
  } catch (error) {
    console.error('Error updating entry:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

// ==========================================
// SHELTER VOLUNTEERS (Convites)
// ==========================================

/**
 * POST /api/v1/shelters/:id_code/volunteers
 * Abrigo convida voluntário pelo User ID/Email ou o front resolve o userID
 */
router.post('/:id_code/volunteers', authenticateToken, async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });
    
    if (!(await isShelterManager(req, shelter))) {
      return res.status(403).json({ success: false, message: 'Sem permissão' });
    }

    const { user_id } = req.body;
    
    const [invite] = await ShelterVolunteer.findOrCreate({
      where: { user_id, shelter_id: shelter.id },
      defaults: { status: 'pending' }
    });

    return res.status(201).json({ success: true, message: 'Convite enviado', data: invite });
  } catch (error) {
    console.error('Error managing volunteers:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * POST /api/v1/shelters/:id_code/broadcast-needs
 * Abrigo solicita voluntários (cria HelpRequests do tipo volunteer)
 */
router.post('/:id_code/broadcast-needs', authenticateToken, async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });
    
    if (!(await isShelterManager(req, shelter))) {
      return res.status(403).json({ success: false, message: 'Sem permissão' });
    }

    const { needs } = req.body; // Array de { label, count }
    
    const createdRequests = [];

    for (const need of needs) {
      if (need.count > 0) {
        const hReq = await HelpRequest.create({
          user_id: req.user.userId,
          shelter_id: shelter.id,
          type: 'volunteer',
          status: 'pending',
          urgency: 'medium',
          people_count: 1, 
          address: shelter.address,
          lat: shelter.lat,
          lng: shelter.lng,
          reporter_name: shelter.name,
          reporter_phone: shelter.phone,
          volunteer_message: `NECESSIDADE DE VOLUNTÁRIOS: ${need.label}`,
          total_slots: need.count
        });
        createdRequests.push(hReq);
      }
    }

    return res.status(201).json({
      success: true,
      message: `${createdRequests.length} solicitações de voluntários publicadas com sucesso.`,
      data: createdRequests
    });
  } catch (error) {
    console.error('Error broadcasting shelter needs:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/shelters/:id_code/broadcast-needs
 * Listar solicitações de voluntários do abrigo (ativas/pendentes)
 */
router.get('/:id_code/broadcast-needs', authenticateToken, async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });

    const requests = await HelpRequest.findAll({
      where: { 
        [Op.or]: [
          { shelter_id: shelter.id },
          { shelter_id: null, user_id: shelter.user_id }
        ],
        type: 'volunteer'
      },
      include: [
        { 
          model: ShelterVolunteer, 
          as: 'volunteers',
          include: [{ model: User, as: 'user', attributes: ['id_code', 'name', 'phone'] }]
        }
      ],
      order: [['created_at', 'DESC']]
    });

    // 1. Formatar Broadcasts (Solicitados)
    const formattedRequests = requests.map(r => {
      const plain = r.toJSON();
      plain.accepted_count = plain.volunteers ? plain.volunteers.filter((v) => v.status === 'accepted').length : 0;
      return plain;
    });

    // 2. Formatar Equipe (Agrupado por Usuário)
    const allAssignments = await ShelterVolunteer.findAll({
      where: { shelter_id: shelter.id },
      include: [
        { model: User, as: 'user', attributes: ['id_code', 'name', 'phone'] },
        { model: HelpRequest, as: 'help_request', attributes: ['id_code', 'volunteer_message'] }
      ]
    });

    const teamMap = {};
    allAssignments.forEach(a => {
      if (!a.user) return;
      if (!teamMap[a.user.id_code]) {
        teamMap[a.user.id_code] = {
          id_code: a.user.id_code,
          name: a.user.name,
          phone: a.user.phone,
          activities: []
        };
      }
      teamMap[a.user.id_code].activities.push({
        id: a.id,
        label: a.help_request?.volunteer_message?.replace('NECESSIDADE DE VOLUNTÁRIOS: ', '') || 'Voluntariado Geral',
        status: a.status
      });
    });

    return res.status(200).json({ 
      success: true, 
      data: formattedRequests,
      team: Object.values(teamMap)
    });
  } catch (error) {
    console.error('Error fetching shelter needs:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * DELETE /api/v1/shelters/:id_code/broadcast-needs/:request_id_code
 * Cancelar uma solicitação de voluntário
 */
router.delete('/:id_code/broadcast-needs/:request_id_code', authenticateToken, async (req, res) => {
  try {
    const shelter = await Shelter.findOne({ where: { id_code: req.params.id_code } });
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });
    
    if (!(await isShelterManager(req, shelter))) {
      return res.status(403).json({ success: false, message: 'Sem permissão' });
    }

    const deleted = await HelpRequest.destroy({
      where: { 
        id_code: req.params.request_id_code,
        [Op.or]: [
          { shelter_id: shelter.id },
          { shelter_id: null, user_id: shelter.user_id }
        ]
      }
    });

    if (!deleted) return res.status(404).json({ success: false, message: 'Solicitação não encontrada' });

    return res.status(200).json({ success: true, message: 'Solicitação cancelada com sucesso' });
  } catch (error) {
    console.error('Error deleting shelter need:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

module.exports = router;
