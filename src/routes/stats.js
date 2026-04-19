const express = require('express');
const router = express.Router();
const { HelpRequest, VolunteerProfile, User, sequelize } = require('../models');
const { authenticateToken } = require('../middlewares/auth');
const { Op, fn, col } = require('sequelize');

/**
 * GET /api/v1/stats
 * Dashboard de KPIs dinâmicos com RBAC e filtros temporais
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { date_start, date_end, user_id_code } = req.query;
    const role = req.user.role; // master, admin, volunteer
    const userId = req.user.userId;

    // --- 1. Configuração de Filtros Temporais ---
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const timeFilter = {
      [Op.gte]: startOfToday
    };

    const rangeFilter = {};
    if (date_start && date_end) {
      rangeFilter[Op.between] = [new Date(date_start), new Date(date_end)];
    }

    // --- 2. Busca de Métricas Globais (Admin/Master) ---
    // Mesmo voluntários podem ver alguns dados globais para contexto
    
    // Contagens de Pedidos
    const totalRequests = await HelpRequest.count();
    const openRequests = await HelpRequest.count({ where: { status: 'pending' } });
    const resolvedRequests = await HelpRequest.count({ where: { status: 'resolved' } });
    
    // Impacto Humano (Pessoas Beneficiadas - Soma de people_count)
    const totalPeopleBenefited = await HelpRequest.sum('people_count') || 0;
    const peopleBenefitedToday = await HelpRequest.sum('people_count', {
      where: { 
        status: 'resolved',
        finished_at: timeFilter 
      }
    }) || 0;

    // Voluntários
    const totalVolunteers = await VolunteerProfile.count();
    // Voluntários Ativos no Dia (quem aceitou ou finalizou algo hoje)
    const activeVolunteersToday = await HelpRequest.count({
      distinct: true,
      col: 'accepted_by',
      where: {
        [Op.or]: [
          { created_at: timeFilter },
          { finished_at: timeFilter }
        ],
        accepted_by: { [Op.ne]: null }
      }
    });

    // --- 3. Métricas Específicas do Voluntário (Progressivo) ---
    let myStats = null;
    if (role === 'volunteer' || user_id_code) {
      // Se for Admin consultando um voluntário específico via id_code
      let targetUserId = userId;
      if (user_id_code && (role === 'admin' || role === 'master')) {
        const targetUser = await User.findOne({ where: { id_code: user_id_code } });
        if (targetUser) targetUserId = targetUser.id;
      }

      const myResolved = await HelpRequest.count({ 
        where: { accepted_by: targetUserId, status: 'resolved' } 
      });
      const myPeopleTotal = await HelpRequest.sum('people_count', {
        where: { accepted_by: targetUserId, status: 'resolved' }
      }) || 0;
      const myPeopleToday = await HelpRequest.sum('people_count', {
        where: { 
            accepted_by: targetUserId, 
            status: 'resolved',
            finished_at: timeFilter
        }
      }) || 0;

      myStats = {
        resolved: myResolved,
        people_impacted_total: myPeopleTotal,
        people_impacted_today: myPeopleToday
      };
    }

    // --- 4. Resposta Estruturada por Role ---
    const response = {
      success: true,
      data: {
        global: {
          requests: {
            total: totalRequests,
            open: openRequests,
            resolved: resolvedRequests
          },
          volunteers: {
            total: totalVolunteers,
            active_today: activeVolunteersToday
          },
          impact: {
            total_people: totalPeopleBenefited,
            people_today: peopleBenefitedToday
          }
        }
      }
    };

    if (myStats) {
      response.data.personal = myStats;
    }

    return res.status(200).json(response);

  } catch (error) {
    console.error('Error generating stats:', error);
    return res.status(500).json({ success: false, message: 'Erro ao processar indicadores' });
  }
});

module.exports = router;
