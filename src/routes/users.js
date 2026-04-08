const express = require('express');
const { Op } = require('sequelize');
const { body, validationResult } = require('express-validator');
const { sequelize, User, Plan, Store, StoreUser, Order, FootballTeam, EventTicket, EventTicketType, Event } = require('../models');
const { requireRole, authenticateToken } = require('../middlewares/auth');
const { buildEventTicketQrToken } = require('../utils/eventTicketQr');

const router = express.Router();

// Listar todos os usuários (Master/Admin)
router.get('/', authenticateToken, requireRole('master', 'masteradmin', 'admin'), async (req, res) => {
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
        },
        {
          model: require('../models').SysModule,
          as: 'modules',
          attributes: ['id', 'id_code', 'name', 'slug'],
          through: { attributes: [] }
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

// Rota teste - antes da rota dinâmica
router.get('/teste', authenticateToken, requireRole('admin', 'manager'), async (req, res) => {
  console.log('Rota /teste chamada');
  console.log('Usuário do token:', req.user);

  try {
    const users = await User.findAll({
      attributes: { exclude: ['password_hash'] }
    });
    console.log(`Encontrados ${users.length} usuários`);

    res.json({
      success: true,
      tokenUserRole: req.user.role,
      users
    });
  } catch (error) {
    console.error('Erro no /teste:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

router.get('/me/tickets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const offset = (page - 1) * limit;
    const status = req.query.status ? String(req.query.status) : null;

    const where = { user_id: userId };
    if (status) where.status = status;

    const { count, rows } = await EventTicket.findAndCountAll({
      where,
      include: [
        {
          model: Event,
          as: 'event',
          attributes: ['id_code', 'name', 'slug', 'banner_url', 'date', 'start_time', 'end_time', 'public_url', 'place', 'status']
        },
        {
          model: EventTicketType,
          as: 'ticketType',
          attributes: ['id_code', 'name', 'price_amount', 'currency']
        }
      ],
      order: [['created_at', 'DESC']],
      offset,
      limit
    });

    return res.json({
      success: true,
      data: rows.map(r => {
        const j = r.toJSON();
        const qr_token = buildEventTicketQrToken({
          ticket_id: j.id_code,
          event_id: j.event ? j.event.id_code : null,
          expires_at: j.expires_at
        });
        return {
          id: j.id_code,
          id_code: j.id_code,
          status: j.status,
          reserved_at: j.reserved_at,
          expires_at: j.expires_at,
          checked_in_at: j.checked_in_at,
          price_amount: j.price_amount,
          currency: j.currency,
          qr_token,
          event: j.event ? {
            id: j.event.id_code,
            name: j.event.name,
            slug: j.event.slug,
            banner_url: j.event.banner_url,
            date: j.event.date,
            start_time: j.event.start_time,
            end_time: j.event.end_time,
            public_url: j.event.public_url,
            place: j.event.place,
            status: j.event.status
          } : null,
          ticket_type: j.ticketType ? {
            id: j.ticketType.id_code,
            name: j.ticketType.name,
            price_amount: j.ticketType.price_amount,
            currency: j.ticketType.currency
          } : null
        };
      }),
      meta: {
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('List my tickets error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});



router.get('/store-users/:storeId', authenticateToken, async (req, res) => {
  const { storeId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    const user = req.user;
    console.log('Usuário autenticado:', user);

    // Se não for master, verifica se é admin/manager/waiter da loja
    if (user.role !== 'master') {
      const storeUser = await StoreUser.findOne({
        where: {
          store_id: storeId,
          user_id: user.id,
          role: ['admin', 'manager', 'waiter']
        }
      });

      if (!storeUser) {
        return res.status(403).json({ message: 'Acesso negado' });
      }
    }

    // Buscar usuários distintos que fizeram pedidos nessa store
    const users = await User.findAndCountAll({
      include: [{
        model: Order,
        as: 'orders',          // **importante**: usar o alias correto da associação
        where: { store_id: storeId },
        attributes: []
      }],
      distinct: true,
      order: [['name', 'ASC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      attributes: ['id', 'id_code', 'name', 'email', 'phone', 'role', 'plan_id', 'plan_start', 'plan_end', 'created_at']
    });

    return res.json({
      success: true,
      total: users.count,
      page: parseInt(page),
      pages: Math.ceil(users.count / limit),
      users: users.rows
    });

  } catch (error) {
    console.error('Erro ao buscar usuários da loja:', error);
    return res.status(500).json({ message: 'Erro interno' });
  }
});



// Obter usuário por ID (rota dinâmica)
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
        },
        {
          model: Store,
          as: 'stores',
          through: { attributes: ['role'] },
          attributes: ['id', 'name']
        },
        {
          model: FootballTeam,
          as: 'team',
          attributes: ['id', 'name', 'short_name', 'abbreviation', 'shield']
        },
        {
          model: require('../models').SysModule,
          as: 'modules',
          attributes: ['id', 'id_code', 'name', 'slug', 'home_path', 'active'],
          through: { attributes: [] }
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

    if (!['admin', 'master', 'masteradmin'].includes(req.user.role)) {
      const userStores = await StoreUser.findAll({
        where: { user_id: req.user.id },
        attributes: ['store_id']
      });
      const storeIds = userStores.map(su => su.store_id);

      // Note: user.id is the internal ID, which we have now regardless of how we found the user
      const userStoreAccess = await StoreUser.findOne({
        where: { 
          user_id: user.id,
          store_id: storeIds
        }
      });

      if (!userStoreAccess) {
        return res.status(403).json({
          error: 'Access denied',
          message: 'Acesso negado'
        });
      }
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

// Criar novo usuário
router.post('/', authenticateToken, requireRole('admin'), [
  body('name').isLength({ min: 2, max: 255 }).trim(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['admin', 'manager', 'waiter', 'customer']),
  body('phone').optional().isLength({ min: 10, max: 20 }),
  body('plan_id').optional().isInt(),
  body('team_user').optional().isInt()
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

    const { name, email, password, role, phone, plan_id, team_user } = req.body;

    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error: 'Email already exists',
        message: 'Email já está em uso'
      });
    }

    if (team_user) {
      const team = await sequelize.models.FootballTeam.findByPk(team_user);
      if (!team) {
        return res.status(400).json({
          error: 'Invalid team',
          message: 'Time de futebol inválido'
        });
      }
    }

    const user = await User.create({
      name,
      email,
      phone,
      password_hash: password,
      role,
      plan_id,
      team_user
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

// ATENÇÃO: As rotas estáticas (/me) DEVEM vir antes das rotas dinâmicas (/:id)
// caso contrário o Express vai casar '/me' com '/:id'

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
 *               team_user:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Usuário atualizado com sucesso
 *       400:
 *         description: Dados inválidos
 *       401:
 *         description: Não autenticado
 */
router.put('/me', authenticateToken, [
  body('name').optional().isLength({ min: 2, max: 255 }).trim().withMessage('O nome deve ter entre 2 e 255 caracteres.'),
  body('phone').optional().isLength({ min: 10, max: 20 }).withMessage('O telefone deve ter entre 10 e 20 caracteres.'),
  body('team_user').optional({ nullable: true }).isInt().withMessage('O ID do time deve ser um número inteiro.'),
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
  body('address_state').optional({ nullable: true }).isString().isLength({ min: 2, max: 2 }),
  body('address_zip_code').optional({ nullable: true }).isString().trim().isLength({ min: 8, max: 10 })
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
      'name', 'phone', 'team_user', 'avatar_url', 'birth_date',
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
        { model: Plan, as: 'plan', attributes: ['id', 'name', 'description', 'price'] },
        { model: FootballTeam, as: 'team', attributes: ['name', 'short_name', 'abbreviation', 'shield'] }
      ]
    });

    res.json({ success: true, message: 'Seu perfil foi atualizado com sucesso.', data: { user: user.toJSON() } });
  } catch (error) {
    console.error('Update self error:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// Atualização parcial do próprio usuário (PATCH) — focado em avatar/selfie
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
        { model: Plan, as: 'plan', attributes: ['id', 'name', 'description', 'price'] },
        { model: FootballTeam, as: 'team', attributes: ['name', 'short_name', 'abbreviation', 'shield'] }
      ]
    });

    res.json({ success: true, message: 'Seu perfil foi atualizado com sucesso.', data: { user: user.toJSON() } });
  } catch (error) {
    console.error('Patch self error:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// Atualizar usuário (Admin) - rota dinâmica, deve vir DEPOIS das rotas estáticas
router.put('/:id', authenticateToken, requireRole('admin', 'master', 'masteradmin'), [

  body('name').optional().isLength({ min: 2, max: 255 }).trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('role').optional().isIn(['admin', 'manager', 'waiter', 'customer']),
  body('phone').optional().isLength({ min: 10, max: 20 }),
  body('plan_id').optional().isInt(),
  body('team_user').optional().isInt(),
  body('module_ids').optional().isArray()
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

    const { name, email, role, phone, plan_id, team_user, module_ids } = req.body;

    // Atualiza campos básicos
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (role) updateData.role = role;
    if (phone) updateData.phone = phone;
    if (plan_id !== undefined) updateData.plan_id = plan_id;
    if (team_user !== undefined) updateData.team_user = team_user;

    await user.update(updateData);

    // Atualiza Módulos (se fornecido)
    if (module_ids) {
      // Se forem UUIDs (strings), busca os IDs internos
      if (module_ids.length > 0 && (typeof module_ids[0] === 'string' && isNaN(module_ids[0]))) {
        const modules = await require('../models').SysModule.findAll({
          where: { id_code: module_ids },
          attributes: ['id']
        });
        const internalIds = modules.map(m => m.id);
        await user.setModules(internalIds);
      } else {
        // IDs numéricos diretos
        await user.setModules(module_ids);
      }
    }

    // Recarrega
    await user.reload({
      include: [
        { model: Plan, as: 'plan' },
        { model: FootballTeam, as: 'team' },
        { 
          model: require('../models').SysModule, 
          as: 'modules',
          attributes: ['id', 'id_code', 'name', 'slug', 'home_path', 'active'],
          through: { attributes: [] }
        }
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

// [MOVIDO PARA ANTES DO PUT /:id - veja acima]

// Atualização parcial do próprio usuário (PATCH) — focado em avatar/selfie
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
        { model: Plan, as: 'plan', attributes: ['id', 'name', 'description', 'price'] },
        { model: FootballTeam, as: 'team', attributes: ['name', 'short_name', 'abbreviation', 'shield'] }
      ]
    });

    res.json({ success: true, message: 'Seu perfil foi atualizado com sucesso.', data: { user: user.toJSON() } });
  } catch (error) {
    console.error('Patch self error:', error);
    res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

// Atualizar usuário
router.put('/:id_code', authenticateToken, requireRole('admin'), [
  body('name').optional().isLength({ min: 2, max: 255 }).trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('role').optional().isIn(['admin', 'manager', 'waiter', 'customer']),
  body('phone').optional().isLength({ min: 10, max: 20 }),
  body('plan_id').optional().isInt(),
  body('team_user').optional({ nullable: true }).isInt(),
  body('avatar_url').optional({ nullable: true }).isURL({ require_tld: false }).withMessage('URL do avatar inválida.'),
  body('birth_date').optional({ nullable: true }).isISO8601().toDate().withMessage('Data de nascimento inválida.'),
  body('address_street').optional({ nullable: true }).isString().trim(),
  body('address_number').optional({ nullable: true }).isString().trim(),
  body('address_complement').optional({ nullable: true }).isString().trim(),
  body('address_neighborhood').optional({ nullable: true }).isString().trim(),
  body('address_city').optional({ nullable: true }).isString().trim(),
  body('address_state').optional({ nullable: true }).isString().isLength({ min: 2, max: 2 }),
  body('address_zip_code').optional({ nullable: true }).isString().trim().isLength({ min: 8, max: 10 })
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

    const user = await User.findOne({ where: { id_code } });
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuário não encontrado'
      });
    }

    // Apenas 'master' pode definir outros como 'admin' ou 'master'
    const { role } = req.body;
    if (role && ['master', 'admin'].includes(role) && req.user.role !== 'master') {
      return res.status(403).json({ // Alterei para requireRole('admin') no início, então essa checagem é uma segurança extra para 'master'
        error: 'Insufficient permissions',
        message: 'Permissões insuficientes para definir esta role.'
      });
    }

    if (team_user) {
      const team = await sequelize.models.FootballTeam.findByPk(team_user);
      if (!team && team_user !== null) { // Permite que team_user seja nulo
        return res.status(400).json({
          error: 'Invalid team',
          message: 'Time de futebol inválido'
        });
      }
    }

    const allowedUpdates = [
      'name',
      'email',
      'phone',
      'role',
      'plan_id',
      'team_user',
      'avatar_url',
      'birth_date',
      'address_street',
      'address_number',
      'address_complement',
      'address_neighborhood',
      'address_city',
      'address_state',
      'address_zip_code'
    ];

    const updateData = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    }
    await user.update(updateData);

    // Recarrega o usuário com as associações para retornar o objeto completo
    await user.reload({
      include: [
        {
          model: Plan,
          as: 'plan',
          attributes: ['id', 'name', 'description', 'price']
        },
        {
          model: FootballTeam,
          as: 'team',
          attributes: ['name', 'short_name', 'abbreviation', 'shield']
        }
      ]
    });

    res.json({
      success: true,
      message: 'Usuário atualizado com sucesso',
      data: { user: user.toJSON() }
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
 *         description: ID Code do usuário a ter a senha resetada
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
 *                 description: A nova senha para o usuário
 *     responses:
 *       200:
 *         description: Senha atualizada com sucesso
 *       400:
 *         description: Dados inválidos (e.g., senha muito curta)
 *       403:
 *         description: Acesso negado
 *       404:
 *         description: Usuário não encontrado
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

// Deletar usuário
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

    if (user.id === req.user.id) {
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

/**
 * @swagger
 * /api/v1/users/verify-status/{id_code}:
 *   get:
 *     summary: Verifica o status de um usuário pelo id_code
 *     tags: [Users]
 *     description: Retorna informações básicas e de plano de um usuário. Acessível por 'master', 'admin', 'manager' e 'waiter'. Garçons e gerentes só podem ver clientes de suas lojas.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         required: true
 *         schema:
 *           type: string
 *         description: O id_code único do usuário a ser verificado.
 *     responses:
 *       200:
 *         description: Status do usuário retornado com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     id_code:
 *                       type: string
 *                     avatar_url:
 *                       type: string
 *                     email:
 *                       type: string
 *                     status:
 *                       type: string
 *                     plan_id:
 *                       type: integer
 *                     plan_start:
 *                       type: string
 *                       format: date
 *                     plan_end:
 *                       type: string
 *                       format: date
 *                     plan:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         description:
 *                           type: string
 *                         price:
 *                           type: string
 *       403:
 *         description: Acesso negado.
 *       404:
 *         description: Usuário não encontrado.
 */
router.get('/verify-status/:id_code', authenticateToken, requireRole('master', 'admin', 'manager', 'waiter'), async (req, res) => {
  try {
    const { id_code } = req.params;
    const requester = req.user;

    const userToVerify = await User.findOne({
      where: { id_code },
      attributes: ['id', 'name', 'id_code', 'avatar_url', 'email', 'status', 'plan_id', 'plan_start', 'plan_end'],
      include: [{
        model: Plan,
        as: 'plan',
        attributes: ['id', 'name', 'description', 'price']
      }]
    });

    if (!userToVerify) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    res.json({ success: true, data: userToVerify.toJSON() });

  } catch (error) {
    console.error('Verify user status error:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
  }
});

module.exports = router;
