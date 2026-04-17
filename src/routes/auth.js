const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { User, Plan, TokenBlocklist, VolunteerProfile } = require('../models');
const { authenticateToken } = require('../middlewares/auth');
const admin = require('../config/firebaseAdmin');

const crypto = require('crypto');

const router = express.Router();

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login de usuário
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Login realizado com sucesso
 *       400:
 *         description: Dados inválidos
 *       401:
 *         description: Credenciais inválidas
 */
router.post('/login', [
  body('email').isEmail().withMessage('O email fornecido é inválido.').normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('A senha deve ter no mínimo 6 caracteres.')
], async (req, res) => {
  try {
    // Validar dados de entrada
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Dados inválidos',
        details: errors.array()
      });
    }

    const { email, password } = req.body;

    // Buscar usuário
    const user = await User.findOne({
      where: { email },
      include: [
        {
          model: Plan,
          as: 'plan',
          attributes: ['id', 'name', 'description', 'price']
        }
      ]
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Email ou senha inválidos'
      });
    }

    // Verificar senha
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Email ou senha inválidos'
      });
    }

    // Gerar token JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        planId: user.plan_id
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      success: true,
      message: 'Login realizado com sucesso',
      data: {
        user: user.toJSON(),
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * Google OAuth Login
 * POST /api/v1/auth/google
 * body: { idToken }
 */
router.post('/google', [
  body('idToken').isString().withMessage('idToken é obrigatório')
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

    const { idToken } = req.body;

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Token do Google inválido ou expirado'
      });
    }

    const { email, name, picture, sub, email_verified } = decoded;

    if (!email) {
      return res.status(400).json({
        error: 'Email required',
        message: 'Email não disponível no token do Google'
      });
    }

    const include = [
      {
        model: Plan,
        as: 'plan',
        attributes: ['id', 'name', 'description', 'price']
      }
    ];

    // Procura por google_uid (preferencial) ou legado google_id
    let user = await User.findOne({ where: { [Op.or]: [{ google_uid: sub }, { google_id: sub }] }, include });

    if (!user) {
      const userByEmail = await User.findOne({ where: { email } });

      if (userByEmail) {
        await userByEmail.update({
          google_uid: sub,
          google_id: userByEmail.google_id || sub, // mantém compatibilidade com coluna antiga
          email_verified: !!email_verified,
          name: userByEmail.name || name || email,
          avatar_url: userByEmail.avatar_url || picture || null
        });

        user = await User.findOne({ where: { id: userByEmail.id }, include });
      } else {
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const created = await User.create({
          name: name || (email ? email.split('@')[0] : 'Usuário Google'),
          email,
          password: randomPassword,
          role: 'people',
          google_uid: sub,
          google_id: sub, // legado
          avatar_url: picture || null,
          email_verified: !!email_verified
        });

        user = await User.findOne({ where: { id: created.id }, include });
      }
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        planId: user.plan_id
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    return res.json({
      success: true,
      message: 'Login com Google realizado com sucesso',
      data: {
        user: user.toJSON(),
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
      }
    });

  } catch (error) {
    console.error('Google auth error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/auth/register:
 *   post:
 *     summary: Registro de novo usuário
 *     tags: [Auth]
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
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *               phone:
 *                 type: string
 *     responses:
 *       201:
 *         description: Usuário criado com sucesso
 *       400:
 *         description: Dados inválidos
 *       409:
 *         description: Email já existe
 */
router.post('/register', [
  body('name').isLength({ min: 2, max: 255 }).trim().withMessage('O nome deve ter entre 2 e 255 caracteres.'),
  body('email').isEmail().normalizeEmail().withMessage('O email fornecido é inválido.'),
  body('password').isLength({ min: 6 }).withMessage('A senha deve ter no mínimo 6 caracteres.'),
  body('phone').optional().isLength({ min: 10, max: 20 }).withMessage('O telefone deve ter entre 10 e 20 caracteres.')
], async (req, res) => {
  try {
    // Validar dados de entrada
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Dados inválidos',
        details: errors.array()
      });
    }

    const { name, email, password, phone } = req.body;

    // Verificar se email já existe
    const existingUser = await User.findByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error: 'Email already exists',
        message: 'Email já está em uso'
      });
    }

    // Criar usuário (padrão: people)
    const user = await User.create({
      name,
      email,
      phone,
      password,
      role: 'people'
    });

    // Gerar token JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        planId: user.plan_id
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'Usuário criado com sucesso',
      data: {
        user: user.toJSON(),
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
      }
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/auth/me:
 *   get:
 *     summary: Obter dados do usuário logado
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dados do usuário
 *       401:
 *         description: Não autorizado
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // O middleware de auth já adicionou o usuário ao req
    const user = await User.findByPk(req.user.userId, {
      include: [
        {
          model: Plan,
          as: 'plan',
          attributes: ['id', 'name', 'description', 'price']
        },
        {
          model: VolunteerProfile,
          as: 'volunteer_profile'
        }
      ]
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuário não encontrado no banco de dados.'
      });
    }

    // Evitar respostas 304 com payload antigo em /me (dados do usuário mudam com frequência)
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json({
      success: true,
      data: {
        user: user.toJSON()
      }
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
 * /api/v1/auth/refresh:
 *   post:
 *     summary: Renovar token JWT
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token renovado
 *       401:
 *         description: Token inválido
 */
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    // O middleware de auth já validou o token
    const user = req.user;

    // Gerar novo token
    const token = jwt.sign(
      {
        userId: user.userId,
        email: user.email,
        role: user.role,
        planId: user.planId
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      success: true,
      message: 'Token renovado com sucesso',
      data: {
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || '24h'
      }
    });

  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Logout do usuário
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout realizado com sucesso
 */
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.decode(token);
      await TokenBlocklist.create({
        token,
        expiresAt: new Date(decoded.exp * 1000)
      });
    }

    res.json({
      success: true,
      message: 'Logout realizado com sucesso'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

module.exports = router;
