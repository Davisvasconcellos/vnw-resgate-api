const express = require('express');
const router = express.Router();
const { MissingPerson, User } = require('../models');
const { authenticateToken } = require('../middlewares/auth');
const { Op } = require('sequelize');

const extractUserIfExists = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return next();
  try {
    await new Promise((resolve) => authenticateToken(req, res, () => resolve()));
    next();
  } catch (e) {
    next();
  }
};

/**
 * @swagger
 * components:
 *   schemas:
 *     MissingPerson:
 *       type: object
 *       properties:
 *         id_code: { type: string }
 *         name: { type: string }
 *         age: { type: integer }
 *         status: { type: string, enum: [missing, found] }
 *         last_seen_location: { type: string }
 *         description: { type: string }
 */

/**
 * @swagger
 * /api/v1/missing:
 *   post:
 *     summary: Registrar uma pessoa desaparecida
 *     tags: [Missing Persons]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/MissingPerson' }
 *   get:
 *     summary: Listar todas as pessoas desaparecidas
 *     tags: [Missing Persons]
 *     parameters:
 *       - in: query
 *         name: name
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [missing, found] }
 */
router.post('/', extractUserIfExists, async (req, res) => {
  try {
    const data = req.body;
    if (req.user) data.user_id = req.user.userId;

    const missing = await MissingPerson.create(data);
    
    return res.status(201).json({
      success: true,
      message: 'Registro criado com sucesso.',
      data: missing
    });
  } catch (error) {
    console.error('Error creating missing person:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/missing
 * Listar desaparecidos (busca por nome, status)
 */
router.get('/', async (req, res) => {
  try {
    const { name, status, limit = 50, offset = 0 } = req.query;
    const whereClause = {};

    if (status) whereClause.status = status;
    if (name) {
      whereClause.name = {
        [Op.iLike]: `%${name}%` // case insensitive (Postgres)
      };
    }

    const { rows, count } = await MissingPerson.findAndCountAll({
      where: whereClause,
      include: [{ model: User, as: 'reporter', attributes: ['name', 'phone'] }],
      order: [['created_at', 'DESC']],
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
    console.error('Error fetching missing persons:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * GET /api/v1/missing/:id_code
 */
router.get('/:id_code', async (req, res) => {
  try {
    const missing = await MissingPerson.findOne({
      where: { id_code: req.params.id_code },
      include: [{ model: User, as: 'reporter', attributes: ['name', 'phone'] }]
    });

    if (!missing) {
      return res.status(404).json({ success: false, message: 'Registro não encontrado' });
    }

    return res.status(200).json({ success: true, data: missing });
  } catch (error) {
    console.error('Error fetching missing detail:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

/**
 * PUT /api/v1/missing/:id_code/status
 * Marcar como found
 */
router.put('/:id_code/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const missing = await MissingPerson.findOne({ where: { id_code: req.params.id_code } });

    if (!missing) {
      return res.status(404).json({ success: false, message: 'Registro não encontrado' });
    }

    missing.status = status || missing.status;
    await missing.save();

    return res.status(200).json({
      success: true,
      message: 'Status atualizado com sucesso.',
      data: missing
    });
  } catch (error) {
    console.error('Error updating missing person status:', error);
    return res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

module.exports = router;
