const express = require('express');
const { FootballTeam } = require('../models');
const { authenticateToken, requireModule } = require('../middlewares/auth');

const router = express.Router();

/**
 * @swagger
 * /api/v1/football-teams:
 *   get:
 *     summary: Listar todos os times de futebol
 *     tags: [FootballTeams]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Uma lista de times de futebol.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/FootballTeam'
 *       401:
 *         description: Não autenticado
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const teams = await FootballTeam.findAll({
      order: [['name', 'ASC']]
    });
    res.json({ success: true, data: teams });
  } catch (error) {
    console.error('Error fetching football teams:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Erro ao buscar os times de futebol.' });
  }
});

module.exports = router;