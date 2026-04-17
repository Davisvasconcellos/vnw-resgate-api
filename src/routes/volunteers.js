const express = require('express');
const router = express.Router();
const { VolunteerProfile, HelpRequest, ShelterVolunteer, Shelter, sequelize } = require('../models');
const { authenticateToken } = require('../middlewares/auth');

/**
 * POST /api/v1/volunteers/profile
 * Criar perfil do voluntário (Onboarding)
 */
router.post('/profile', authenticateToken, async (req, res) => {
  try {
    const data = req.body;
    data.user_id = req.user.userId; // Vincula ao usuário logado
    
    // Deleta se já existir (upsert simples)
    await VolunteerProfile.destroy({ where: { user_id: req.user.userId } });
    
    const profile = await VolunteerProfile.create(data);
    
    return res.status(201).json({
      success: true,
      message: 'Perfil de voluntário atualizado.',
      data: profile
    });
  } catch (error) {
    console.error('Error managing volunteer profile:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/volunteers/profile
 * Busca o perfil do voluntário logado
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const profile = await VolunteerProfile.findOne({ where: { user_id: req.user.userId } });
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Perfil não encontrado' });
    }
    return res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error('Error fetching volunteer profile:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/volunteers/tasks
 * Listar tarefas atribuídas ao voluntário (help_requests aceitos + abrigos vinculados)
 */
router.get('/tasks', authenticateToken, async (req, res) => {
  try {
    // 1. Help Requests assumidos por este voluntario
    const requests = await HelpRequest.findAll({
      where: { accepted_by: req.user.userId },
      order: [['updated_at', 'DESC']]
    });

    // 2. Abrigos onde atua ou foi convidado
    const shelterLinks = await ShelterVolunteer.findAll({
      where: { user_id: req.user.userId }
    });

    // Buscar os data dos abrigos vinculados manualmente ou usando includes
    let shelters = [];
    if (shelterLinks.length > 0) {
      const shelterIds = shelterLinks.map(s => s.shelter_id);
      shelters = await Shelter.findAll({
        where: { id: { [sequelize.Op.in]: shelterIds } }
      });
      // Merge status da pivot
      shelters = shelters.map(shelter => {
        const link = shelterLinks.find(s => s.shelter_id === shelter.id);
        const json = shelter.toJSON();
        json.volunteer_status = link.status;
        return json;
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        help_requests: requests,
        shelters: shelters
      }
    });

  } catch (error) {
    console.error('Error fetching volunteer tasks:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * PUT /api/v1/volunteers/invites/:shelter_id_code
 * Voluntário aceita/rejeita convite de um abrigo
 */
router.put('/invites/:shelter_id_code', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body; // 'accepted' 
    const shelter = await Shelter.findOne({ where: { id_code: req.params.shelter_id_code }});
    
    if (!shelter) return res.status(404).json({ success: false, message: 'Abrigo não encontrado' });

    const link = await ShelterVolunteer.findOne({
      where: { shelter_id: shelter.id, user_id: req.user.userId }
    });

    if (!link) return res.status(404).json({ success: false, message: 'Convite não encontrado' });

    link.status = status;
    await link.save();

    return res.status(200).json({ success: true, message: 'Status do convite atualizado' });
  } catch (error) {
    console.error('Error updating invite:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

module.exports = router;
