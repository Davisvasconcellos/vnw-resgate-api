const crypto = require('crypto');
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { authenticateToken } = require('../middlewares/auth');
const { requireStoreContext, requireStoreAccess } = require('../middlewares/storeContext');
const { Store, User, StoreInvite, StoreMember, sequelize } = require('../models');

const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     StoreInvite:
 *       type: object
 *       properties:
 *         id_code:
 *           type: string
 *         invited_email:
 *           type: string
 *         role:
 *           type: string
 *           enum: [manager, collaborator, viewer]
 *         permissions:
 *           type: array
 *           items:
 *             type: string
 *         status:
 *           type: string
 *           enum: [pending, accepted, revoked, expired]
 *         expires_at:
 *           type: string
 *           format: date-time
 *         accepted_at:
 *           type: string
 *           format: date-time
 *         revoked_at:
 *           type: string
 *           format: date-time
 *         created_at:
 *           type: string
 *           format: date-time
 *
 * /api/v1/store-invites:
 *   get:
 *     summary: Listar convites da store
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: store_id
 *         schema:
 *           type: string
 *         required: true
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, accepted, revoked, expired]
 *     responses:
 *       200:
 *         description: Lista de convites
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
 *                     $ref: '#/components/schemas/StoreInvite'
 *
 *   post:
 *     summary: Criar convite (retorna link copiável)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: store_id
 *         schema:
 *           type: string
 *         required: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [manager, collaborator, viewer]
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 *               expires_in_days:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 30
 *     responses:
 *       201:
 *         description: Convite criado
 *
 * /api/v1/store-invites/accept:
 *   post:
 *     summary: Aceitar convite (usuário autenticado)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Convite aceito
 *
 * /api/v1/store-invites/{id_code}/regenerate:
 *   post:
 *     summary: Regenerar link do convite pendente
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         schema:
 *           type: string
 *         required: true
 *       - in: query
 *         name: store_id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: Link regenerado
 *
 * /api/v1/store-invites/{id_code}/revoke:
 *   post:
 *     summary: Revogar convite pendente
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         schema:
 *           type: string
 *         required: true
 *       - in: query
 *         name: store_id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: Convite revogado
 */

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getInviteLink(token, req) {
  const envBase = process.env.INVITE_PUBLIC_BASE_URL || process.env.FRONTEND_PUBLIC_BASE_URL;
  const origin = req && typeof req.get === 'function' ? req.get('origin') : null;
  const allowOriginFallback = process.env.NODE_ENV !== 'production';
  const base = envBase || (allowOriginFallback && origin ? origin : 'http://localhost:3000');
  const url = new URL('/invite/accept', base);
  url.searchParams.set('token', token);
  return url.toString();
}

function getExpirationDate(days = 7) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function assertCanManageInvites(req) {
  const highPrivilegeRoles = ['admin', 'master', 'masteradmin'];
  if (highPrivilegeRoles.includes(req.user.role)) return;

  if (req.store && req.store.owner_id && String(req.store.owner_id) === String(req.user.userId)) return;

  const member = await StoreMember.findOne({
    where: { store_id: req.storeDbId, user_id: req.user.userId, status: 'active' }
  });

  if (member && member.role === 'manager') return;

  const error = new Error('forbidden');
  error.code = 'forbidden';
  throw error;
}

/**
 * @swagger
 * /api/v1/store-invites/my:
 *   get:
 *     summary: Listar convites do usuário autenticado
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, accepted, revoked, expired]
 *         description: "Filtrar por status (padrão: pending)"
 *     responses:
 *       200:
 *         description: Lista de convites do usuário
 */
router.get('/my', [
  authenticateToken,
  query('status').optional().isIn(['pending', 'accepted', 'revoked', 'expired'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    const email = (req.user.email || '').toLowerCase();
    const status = req.query.status || 'pending';

    const invites = await StoreInvite.findAll({
      where: {
        status,
        [Op.or]: [
          { invited_user_id: req.user.userId },
          { invited_email: email }
        ]
      },
      include: [{
        model: Store,
        as: 'store',
        attributes: ['id_code', 'name', 'slug']
      }],
      order: [['created_at', 'DESC']],
      attributes: [
        'id_code',
        'invited_email',
        'role',
        'permissions',
        'status',
        'expires_at',
        'accepted_at',
        'revoked_at',
        'created_at'
      ]
    });

    return res.json({ success: true, data: invites });
  } catch (error) {
    console.error('My invites list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', [
  authenticateToken,
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  query('status').optional().isIn(['pending', 'accepted', 'revoked', 'expired'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    await assertCanManageInvites(req);

    const where = { store_id: req.storeDbId };
    if (req.query.status) where.status = req.query.status;

    const invites = await StoreInvite.findAll({
      where,
      order: [['created_at', 'DESC']],
      attributes: [
        'id_code',
        'invited_email',
        'invited_user_id',
        'role',
        'permissions',
        'status',
        'expires_at',
        'accepted_user_id',
        'accepted_at',
        'revoked_at',
        'created_at'
      ]
    });

    const normalize = (record) => (record && typeof record.toJSON === 'function') ? record.toJSON() : record;
    const baseInvites = invites.map(normalize);
    const acceptedUserIds = Array.from(
      new Set(
        baseInvites
          .map((i) => i.accepted_user_id || i.invited_user_id)
          .filter((v) => v !== null && v !== undefined)
          .map((v) => Number(v))
          .filter((v) => !Number.isNaN(v))
      )
    );

    let memberIdCodeByUserId = new Map();
    if (acceptedUserIds.length) {
      const members = await StoreMember.findAll({
        where: { store_id: req.storeDbId, user_id: { [Op.in]: acceptedUserIds } },
        attributes: ['id_code', 'user_id', 'status'],
        include: [{ model: User, as: 'user', attributes: ['id_code', 'name', 'avatar_url'] }]
      });

      memberIdCodeByUserId = new Map(
        members
          .map(normalize)
          .map((m) => [Number(m.user_id), { id_code: m.id_code, status: m.status, user_id_code: m.user ? m.user.id_code : null, user_name: m.user ? m.user.name : null, avatar_url: m.user ? m.user.avatar_url : null }])
      );
    }

    const payload = baseInvites.map((inv) => {
      const userId = Number(inv.accepted_user_id || inv.invited_user_id);
      const member = Number.isNaN(userId) ? null : memberIdCodeByUserId.get(userId) || null;
      return {
        ...inv,
        store_member_id_code: member ? member.id_code : null,
        store_member_status: member ? member.status : null,
        user_id_code: member ? member.user_id_code : null,
        user: member && member.user_id_code ? { id_code: member.user_id_code, name: member.user_name, avatar_url: member.avatar_url } : null
      };
    });

    return res.json({ success: true, data: payload });
  } catch (error) {
    if (error.code === 'forbidden') {
      return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para gerenciar convites' });
    }
    console.error('StoreInvites list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', [
  authenticateToken,
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  body('email').isEmail().normalizeEmail(),
  body('role').optional().isIn(['manager', 'collaborator', 'viewer']),
  body('permissions').optional().isArray(),
  body('expires_in_days').optional().isInt({ min: 1, max: 30 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    await assertCanManageInvites(req);

    const email = String(req.body.email).toLowerCase();
    const role = req.body.role || 'collaborator';
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];
    const expiresInDays = req.body.expires_in_days ? Number(req.body.expires_in_days) : 7;

    const [existingPending] = await StoreInvite.findAll({
      where: {
        store_id: req.storeDbId,
        invited_email: email,
        status: { [Op.in]: ['pending'] }
      },
      limit: 1,
      order: [['created_at', 'DESC']]
    });

    if (existingPending) {
      const token = generateToken();
      await existingPending.update({
        token_hash: hashToken(token),
        expires_at: getExpirationDate(expiresInDays),
        role,
        permissions
      });
      return res.status(201).json({
        success: true,
        data: existingPending,
        invite_link: getInviteLink(token, req)
      });
    }

    const invitedUser = await User.findOne({ where: { email } });
    const token = generateToken();

    const invite = await StoreInvite.create({
      store_id: req.storeDbId,
      invited_email: email,
      invited_user_id: invitedUser ? invitedUser.id : null,
      role,
      permissions,
      status: 'pending',
      token_hash: hashToken(token),
      expires_at: getExpirationDate(expiresInDays),
      created_by_user_id: req.user.userId
    });

    return res.status(201).json({
      success: true,
      data: invite,
      invite_link: getInviteLink(token, req),
      invited_user_exists: !!invitedUser
    });
  } catch (error) {
    if (error.code === 'forbidden') {
      return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para gerenciar convites' });
    }
    if (error && error.name === 'SequelizeForeignKeyConstraintError') {
      const constraint = error.parent && error.parent.constraint ? error.parent.constraint : null;
      if (constraint === 'store_invites_created_by_user_id_fkey') {
        return res.status(401).json({ error: 'Unauthorized', message: 'Sessão inválida. Faça login novamente.' });
      }
      if (constraint === 'store_invites_store_id_fkey') {
        return res.status(400).json({ error: 'Validation error', message: 'Loja inválida para convite.' });
      }
    }
    console.error('StoreInvites create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id_code/regenerate', [
  authenticateToken,
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess
], async (req, res) => {
  try {
    await assertCanManageInvites(req);

    const invite = await StoreInvite.findOne({ where: { id_code: req.params.id_code, store_id: req.storeDbId } });
    if (!invite) {
      return res.status(404).json({ error: 'Not Found', message: 'Convite não encontrado' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'Validation error', message: 'Só é possível regenerar convites pendentes' });
    }

    const token = generateToken();
    await invite.update({
      token_hash: hashToken(token),
      expires_at: getExpirationDate(7)
    });

    return res.json({ success: true, data: invite, invite_link: getInviteLink(token, req) });
  } catch (error) {
    if (error.code === 'forbidden') {
      return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para gerenciar convites' });
    }
    console.error('StoreInvites regenerate error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id_code/revoke', [
  authenticateToken,
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess
], async (req, res) => {
  try {
    await assertCanManageInvites(req);

    const invite = await StoreInvite.findOne({ where: { id_code: req.params.id_code, store_id: req.storeDbId } });
    if (!invite) {
      return res.status(404).json({ error: 'Not Found', message: 'Convite não encontrado' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'Validation error', message: 'Só é possível revogar convites pendentes' });
    }

    await invite.update({
      status: 'revoked',
      revoked_by_user_id: req.user.userId,
      revoked_at: new Date()
    });

    return res.json({ success: true, data: invite });
  } catch (error) {
    if (error.code === 'forbidden') {
      return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para gerenciar convites' });
    }
    console.error('StoreInvites revoke error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/v1/store-invites/{id_code}/accept:
 *   post:
 *     summary: Aceitar convite por id_code (usuário autenticado)
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: Convite aceito
 *       400:
 *         description: Erro de validação
 *       403:
 *         description: Convite não pertence ao e-mail do usuário
 *       404:
 *         description: Convite não encontrado
 */
router.post('/:id_code/accept', [
  authenticateToken
], async (req, res) => {
  try {
    const invite = await StoreInvite.findOne({ where: { id_code: req.params.id_code } });
    if (!invite) {
      return res.status(404).json({ error: 'Not Found', message: 'Convite inválido' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'Validation error', message: 'Convite não está pendente' });
    }

    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      await invite.update({ status: 'expired' });
      return res.status(400).json({ error: 'Validation error', message: 'Convite expirado' });
    }

    if (!req.user.email || String(req.user.email).toLowerCase() !== String(invite.invited_email).toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden', message: 'Este convite não pertence ao seu e-mail' });
    }

    const store = await Store.findByPk(invite.store_id);
    if (!store) {
      return res.status(404).json({ error: 'Not Found', message: 'Loja não encontrada' });
    }

    const result = await sequelize.transaction(async (t) => {
      const existingMember = await StoreMember.findOne({
        where: { store_id: invite.store_id, user_id: req.user.userId },
        transaction: t
      });

      if (existingMember) {
        await existingMember.update(
          { role: invite.role, permissions: invite.permissions, status: 'active' },
          { transaction: t }
        );
      } else {
        await StoreMember.create(
          {
            store_id: invite.store_id,
            user_id: req.user.userId,
            invited_email: invite.invited_email,
            role: invite.role,
            permissions: invite.permissions,
            status: 'active'
          },
          { transaction: t }
        );
      }

      const updatePayload = { status: 'accepted', accepted_user_id: req.user.userId, accepted_at: new Date() };
      if (!invite.invited_user_id) {
        updatePayload.invited_user_id = req.user.userId;
      }
      await invite.update(updatePayload, { transaction: t });

      return invite;
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('StoreInvites accept-by-id error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/accept', [
  authenticateToken,
  body('token').isString().notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation error', details: errors.array() });
  }

  try {
    const token = String(req.body.token);
    const tokenHash = hashToken(token);

    const invite = await StoreInvite.findOne({ where: { token_hash: tokenHash } });
    if (!invite) {
      return res.status(404).json({ error: 'Not Found', message: 'Convite inválido' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'Validation error', message: 'Convite não está pendente' });
    }

    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      await invite.update({ status: 'expired' });
      return res.status(400).json({ error: 'Validation error', message: 'Convite expirado' });
    }

    if (!req.user.email || String(req.user.email).toLowerCase() !== String(invite.invited_email).toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden', message: 'Este convite não pertence ao seu e-mail' });
    }

    const store = await Store.findByPk(invite.store_id);
    if (!store) {
      return res.status(404).json({ error: 'Not Found', message: 'Loja não encontrada' });
    }

    const result = await sequelize.transaction(async (t) => {
      const existingMember = await StoreMember.findOne({
        where: { store_id: invite.store_id, user_id: req.user.userId },
        transaction: t
      });

      if (existingMember) {
        await existingMember.update(
          { role: invite.role, permissions: invite.permissions, status: 'active' },
          { transaction: t }
        );
      } else {
        await StoreMember.create(
          {
            store_id: invite.store_id,
            user_id: req.user.userId,
            invited_email: invite.invited_email,
            role: invite.role,
            permissions: invite.permissions,
            status: 'active'
          },
          { transaction: t }
        );
      }

      await invite.update(
        { status: 'accepted', accepted_user_id: req.user.userId, accepted_at: new Date() },
        { transaction: t }
      );

      return invite;
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('StoreInvites accept error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
