const express = require('express');
const { Op } = require('sequelize');
const { body, validationResult } = require('express-validator');
const { User, Plan } = require('../models');
const { requireRole, authenticateToken } = require('../middlewares/auth');

const router = express.Router();

/**
 * @swagger
 * /api/v1/users:
 *   get:
 *     summary: Listar todos os usuários (Admin/Master)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Página atual
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Itens por página
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Busca por nome ou email
 *     responses:
 *       200:
 *         description: Lista de usuários
 */
router.get('/', authenticateToken, requireRole('master', 'admin'), async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } }
      ];
    }

    const { count, rows } = await User.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['created_at', 'DESC']],
      attributes: { exclude: ['password_hash'] },
      include: [
        {
          model: Plan,
          as: 'plan',
          attributes: ['name']
        }
      ],
      distinct: true
    });

    res.json({
      success: true,
      total: count,
      page: parseInt(page),
      pages: Math.ceil(count / limit),
      data: rows
    });
  } catch (error) {
    console.error('List all users error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/users/{id}:
 *   get:
 *     summary: Obter usuário por ID ou id_code
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados do usuário
 *       404:
 *         description: Usuário não encontrado
 */
router.get('/:id', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;

    const where = isNaN(id) ? { id_code: id } : { id };

    const user = await User.findOne({
      where,
      include: [
        {
          model: Plan,
          as: 'plan',
          attributes: ['id', 'name', 'description', 'price']
        }
      ],
      attributes: { exclude: ['password_hash'] }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuário não encontrado'
      });
    }

    res.json({
      success: true,
      data: { user }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/users:
 *   post:
 *     summary: Criar novo usuário (Admin)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *               - role
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *               role:
 *                 type: string
 *                 enum: [admin, manager, volunteer, people]
 *               phone:
 *                 type: string
 *               plan_id:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Usuário criado
 *       409:
 *         description: Email já existe
 */
router.post('/', authenticateToken, requireRole('admin'), [
  body('name').isLength({ min: 2, max: 255 }).trim(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['admin', 'manager', 'volunteer', 'people']),
  body('phone').optional().isLength({ min: 10, max: 20 }),
  body('plan_id').optional().isInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Dados inválidos',
        details: errors.array()
      });
    }

    const { name, email, password, role, phone, plan_id } = req.body;

    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error: 'Email already exists',
        message: 'Email já está em uso'
      });
    }

    const user = await User.create({
      name,
      email,
      phone,
      password_hash: password,
      role,
      plan_id
    });

    res.status(201).json({
      success: true,
      message: 'Usuário criado com sucesso',
      data: { user: user.toJSON() }
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/users/me:
 *   put:
 *     summary: Atualizar os dados do próprio usuário logado
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               avatar_url:
 *                 type: string
 *     responses:
 *       200:
 *         description: Usuário atualizado com sucesso
 */
router.put('/me', authenticateToken, [
  body('name').optional().isLength({ min: 2, max: 255 }).trim().withMessage('O nome deve ter entre 2 e 255 caracteres.'),
  body('phone').optional().isLength({ min: 10, max: 20 }).withMessage('O telefone deve ter entre 10 e 20 caracteres.'),
  body('avatar_url')
    .optional({ nullable: true })
    .customSanitizer(value => {
      return value === '' ? null : value;
    })
    .isString().withMessage('O caminho do avatar deve ser uma string válida.'),
  body('birth_date').optional({ nullable: true }).isISO8601().toDate().withMessage('Data de nascimento inválida.'),
  body('address_street').optional({ nullable: true }).isString().trim(),
  body('address_number').optional({ nullable: true }).isString().trim(),
  body('address_complement').optional({ nullable: true }).isString().trim(),
  body('address_neighborhood').optional({ nullable: true }).isString().trim(),
  body('address_city').optional({ nullable: true }).isString().trim(),
  body('address_state').optional({ nullable: true }).isString(),
  body('address_zip_code').optional({ nullable: true }).isString().trim(),
  body('lat').optional({ nullable: true }).isNumeric(),
  body('lng').optional({ nullable: true }).isNumeric(),
  body('use_default_location').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', message: 'Dados inválidos', details: errors.array() });
    }

    const user = await User.findByPk(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found', message: 'Usuário não encontrado.' });
    }

    const allowedUpdates = [
      'name', 'phone', 'avatar_url', 'birth_date',
      'address_street', 'address_number', 'address_complement',
      'address_neighborhood', 'address_city', 'address_state', 'address_zip_code',
      'lat', 'lng', 'use_default_location'
    ];

    const updateData = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    }
    console.log('DEBUG: Final updateData for Sequelize:', updateData);
    await user.update(updateData);

    await user.reload({
      include: [
        { model: Plan, as: 'plan', attributes: ['id', 'name', 'description', 'price'] }
      ]
    });

    res.json({ success: true, message: 'Seu perfil foi atualizado com sucesso.', data: { user: user.toJSON() } });
  } catch (error) {
    console.error('Update self error:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/users/me:
 *   patch:
 *     summary: Atualização parcial do próprio perfil (avatar)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/me', authenticateToken, [
  body('avatar_url')
    .optional({ nullable: true })
    .customSanitizer(value => (value === '' ? null : value))
    .isString().withMessage('O caminho do avatar deve ser uma string válida.')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', message: 'Dados inválidos', details: errors.array() });
    }

    const user = await User.findByPk(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found', message: 'Usuário não encontrado.' });
    }

    const updateData = {};
    if (req.body.avatar_url !== undefined) {
      updateData.avatar_url = req.body.avatar_url;
    }

    await user.update(updateData);

    await user.reload({
      include: [
        { model: Plan, as: 'plan', attributes: ['id', 'name', 'description', 'price'] }
      ]
    });

    res.json({ success: true, message: 'Seu perfil foi atualizado com sucesso.', data: { user: user.toJSON() } });
  } catch (error) {
    console.error('Patch self error:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/users/{id}:
 *   put:
 *     summary: Atualizar usuário (Admin/Master)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', authenticateToken, requireRole('admin', 'master'), [
  body('name').optional().isLength({ min: 2, max: 255 }).trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('role').optional().isIn(['admin', 'manager', 'volunteer', 'people']),
  body('phone').optional().isLength({ min: 10, max: 20 }),
  body('plan_id').optional().isInt(),
  body('avatar_url').optional({ nullable: true }).isString(),
  body('birth_date').optional({ nullable: true }).isISO8601().toDate(),
  body('address_street').optional({ nullable: true }).isString().trim(),
  body('address_number').optional({ nullable: true }).isString().trim(),
  body('address_complement').optional({ nullable: true }).isString().trim(),
  body('address_neighborhood').optional({ nullable: true }).isString().trim(),
  body('address_city').optional({ nullable: true }).isString().trim(),
  body('address_state').optional({ nullable: true }).isString(),
  body('address_zip_code').optional({ nullable: true }).isString().trim()
], async (req, res) => {
  try {
    const { id } = req.params;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Dados inválidos',
        details: errors.array()
      });
    }

    const where = isNaN(id) ? { id_code: id } : { id };
    const user = await User.findOne({ where });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuário não encontrado'
      });
    }

    const allowedUpdates = [
      'name', 'email', 'phone', 'role', 'plan_id',
      'avatar_url', 'birth_date',
      'address_street', 'address_number', 'address_complement',
      'address_neighborhood', 'address_city', 'address_state', 'address_zip_code'
    ];

    const updateData = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    }

    await user.update(updateData);

    await user.reload({
      include: [
        { model: Plan, as: 'plan' }
      ],
      attributes: { exclude: ['password_hash'] }
    });

    res.json({
      success: true,
      message: 'Usuário atualizado com sucesso',
      data: { user }
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/users/{id_code}/reset-password:
 *   post:
 *     summary: Resetar a senha de um usuário (Admin/Master)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Senha atualizada com sucesso
 */
router.post('/:id_code/reset-password', authenticateToken, requireRole('master', 'admin'), [
  body('password').isLength({ min: 6 }).withMessage('A nova senha deve ter no mínimo 6 caracteres.')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Dados inválidos',
        details: errors.array()
      });
    }

    const { id_code } = req.params;
    const { password } = req.body;

    const user = await User.findOne({ where: { id_code } });
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuário não encontrado'
      });
    }

    // O hook beforeUpdate no modelo User irá criptografar a senha
    await user.update({ password });

    res.json({
      success: true,
      message: 'Senha do usuário atualizada com sucesso'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/users/{id}:
 *   delete:
 *     summary: Deletar usuário (Admin)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuário não encontrado'
      });
    }

    if (user.id === req.user.userId) {
      return res.status(400).json({
        error: 'Cannot delete self',
        message: 'Não é possível deletar sua própria conta'
      });
    }

    await user.destroy();

    res.json({
      success: true,
      message: 'Usuário deletado com sucesso'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;
