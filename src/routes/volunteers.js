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
    // Buscar todos os vínculos e atribuições do voluntário
    const assignments = await ShelterVolunteer.findAll({
      where: { user_id: req.user.userId },
      include: [
        { 
          model: HelpRequest, 
          as: 'help_request',
          include: [{ model: Shelter, as: 'shelter', attributes: ['id_code', 'name', 'address', 'phone'] }]
        },
        { 
          model: Shelter, 
          as: 'shelter', 
          attributes: ['id_code', 'name', 'address', 'phone'] 
        }
      ],
      order: [['created_at', 'DESC']]
    });

    // Mapear para o formato que o frontend espera (unificando no array de help_requests para compatibilidade)
    const formattedAssignments = assignments.map(a => {
      const json = a.toJSON();
      // Priorizar os dados do abrigo vindos do HelpRequest ou do vínculo direto
      const shelter = json.help_request?.shelter || json.shelter;
      
      return {
        id_code: json.help_request?.id_code || `assignment-${a.id}`,
        type: 'volunteer',
        status: json.status === 'accepted' ? 'ongoing' : json.status === 'finished' ? 'finished' : 'pending',
        volunteer_message: json.help_request?.volunteer_message || 'Voluntariado Geral',
        reporter_name: shelter?.name || 'Abrigo',
        address: shelter?.address,
        shelter_id: shelter?.id_code,
        assignment_id: a.id // Para ações futuras
      };
    });

    // Manter retorno de help_requests legados (individuais) para tras
    const legacyRequests = await HelpRequest.findAll({
      where: { 
        accepted_by: req.user.userId,
        shelter_id: null // Apenas pedidos fora de abrigos (resgate, etc)
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        help_requests: [...formattedAssignments, ...legacyRequests],
        shelters: [] // Agora está unificado em help_requests
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

/**
 * PUT /api/v1/volunteers/missions/:assignment_id/status
 * Atualiza status de uma missão específica (ex: concluir)
 */
router.put('/missions/:assignment_id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const assignment = await ShelterVolunteer.findOne({
      where: { id: req.params.assignment_id, user_id: req.user.userId }
    });

    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Missão não encontrada' });
    }

    assignment.status = status;
    await assignment.save();

    return res.status(200).json({ success: true, message: 'Missão atualizada!' });
  } catch (error) {
    console.error('Error updating mission:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

module.exports = router;
