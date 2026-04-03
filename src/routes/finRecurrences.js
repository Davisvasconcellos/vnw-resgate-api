const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateToken, requireRole, requireModule } = require('../middlewares/auth');
const { requireStoreContext, requireStoreAccess } = require('../middlewares/storeContext');
const { FinRecurrence, FinCategory, FinCostCenter, Party, User, Store } = require('../models');
const { Op } = require('sequelize');
const { generatePendingTransactions } = require('../services/recurrenceService');

const router = express.Router();

const VALID_TYPES = ['PAYABLE', 'RECEIVABLE', 'TRANSFER'];
const VALID_FREQUENCIES = ['weekly', 'monthly', 'yearly'];
const VALID_STATUS = ['active', 'paused', 'finished'];

const toDateOnly = (value) => String(value).slice(0, 10);

const parseDateUtc = (s) => new Date(`${toDateOnly(s)}T00:00:00Z`);

const formatDateOnlyUtc = (date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const daysInMonthUtc = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

const computeInitialNextDueDate = (startDate, frequency, dayOfMonth) => {
  const base = parseDateUtc(startDate);
  if (frequency !== 'monthly') return formatDateOnlyUtc(base);

  const baseYear = base.getUTCFullYear();
  const baseMonth = base.getUTCMonth();
  const baseDay = base.getUTCDate();
  const targetDay = Math.max(1, Math.min(parseInt(dayOfMonth, 10) || 1, 31));

  const monthDays = daysInMonthUtc(baseYear, baseMonth);
  const dayThisMonth = Math.min(targetDay, monthDays);
  let candidate = new Date(Date.UTC(baseYear, baseMonth, dayThisMonth));

  if (baseDay > dayThisMonth) {
    const nextMonthDate = new Date(Date.UTC(baseYear, baseMonth + 1, 1));
    const ny = nextMonthDate.getUTCFullYear();
    const nm = nextMonthDate.getUTCMonth();
    const ndays = daysInMonthUtc(ny, nm);
    const dayNextMonth = Math.min(targetDay, ndays);
    candidate = new Date(Date.UTC(ny, nm, dayNextMonth));
  }

  return formatDateOnlyUtc(candidate);
};

/**
 * @swagger
 * components:
 *   schemas:
 *     FinRecurrence:
 *       type: object
 *       properties:
 *         id_code:
 *           type: string
 *         store_id:
 *           type: string
 *         type:
 *           type: string
 *           enum: [PAYABLE, RECEIVABLE, TRANSFER]
 *         description:
 *           type: string
 *         amount:
 *           type: number
 *         frequency:
 *           type: string
 *           enum: [weekly, monthly, yearly]
 *         start_date:
 *           type: string
 *           format: date
 *         end_date:
 *           type: string
 *           format: date
 *         day_of_month:
 *           type: integer
 *         status:
 *           type: string
 *           enum: [active, paused, finished]
 *
 * /api/v1/financial/recurrences:
 *   get:
 *     summary: Listar recorrências
 *     tags: [Financial]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: store_id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       200:
 *         description: Lista de recorrências
 *
 *   post:
 *     summary: Criar recorrência
 *     tags: [Financial]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: store_id
 *         schema:
 *           type: string
 *         required: true
 *     responses:
 *       201:
 *         description: Recorrência criada
 *
 * /api/v1/financial/recurrences/{id}:
 *   get:
 *     summary: Buscar recorrência por id_code
 *     tags: [Financial]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *         description: Recorrência
 *
 *   patch:
 *     summary: Atualizar recorrência
 *     tags: [Financial]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *         description: Recorrência atualizada
 *
 *   delete:
 *     summary: Remover recorrência
 *     tags: [Financial]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *         description: Recorrência removida
 *
 * /api/v1/financial/recurrences/generate:
 *   post:
 *     summary: Gerar transações pendentes a partir das recorrências
 *     tags: [Financial]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target_date:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: Geração executada
 */

// === GENERATE Transactions from Recurrences ===
router.post(
  '/generate',
  authenticateToken,
  requireModule('financial'),
  requireStoreContext({ allowMissingForRoles: [] }),
  async (req, res) => {
    try {
      const { target_date } = req.body;
      const targetDate = target_date ? new Date(target_date) : new Date();

      const results = await generatePendingTransactions(targetDate, req.storeId);

      res.json({
        message: 'Recurrence generation completed',
        results
      });
    } catch (error) {
      console.error('Error generating recurrences:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// === CREATE Recurrence ===
router.post(
  '/',
  authenticateToken,
  requireModule('financial'),
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  [
    body('type').isIn(VALID_TYPES).withMessage(`Invalid type. Allowed: ${VALID_TYPES.join(', ')}`),
    body('description').notEmpty().withMessage('Description is required'),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('frequency').isIn(VALID_FREQUENCIES).withMessage(`Invalid frequency. Allowed: ${VALID_FREQUENCIES.join(', ')}`),
    body('start_date').isDate().withMessage('Start date must be a valid date'),
    body('day_of_month').isInt({ min: 1, max: 31 }).withMessage('Day of month must be between 1 and 31'),
    body('party_id').optional().isString(),
    body('category_id').optional().isString(),
    body('cost_center_id').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const {
        type,
        description,
        amount,
        frequency,
        start_date,
        end_date,
        day_of_month,
        party_id,
        category_id,
        cost_center_id,
        status = 'active'
      } = req.body;

      const next_due_date = computeInitialNextDueDate(start_date, frequency, day_of_month);

      const recurrence = await FinRecurrence.create({
        store_id: req.storeId,
        type,
        description,
        amount,
        frequency,
        status,
        start_date,
        end_date: end_date || null,
        next_due_date,
        day_of_month,
        party_id: party_id || null,
        category_id: category_id || null,
        cost_center_id: cost_center_id || null,
        created_by_user_id: req.user ? req.user.userId : null // Fix: user ID is usually in req.user.userId or req.user.id depending on auth middleware
      });

      res.status(201).json(recurrence);
    } catch (error) {
      console.error('Error creating recurrence:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// === LIST Recurrences ===
router.get(
  '/',
  authenticateToken,
  requireModule('financial'),
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  [
    query('status').optional().isIn(VALID_STATUS),
    query('type').optional().isIn(VALID_TYPES),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { status, type, page = 1, limit = 20, search } = req.query;
      const offset = (page - 1) * limit;

      const where = { store_id: req.storeId };
      if (status) where.status = status;
      if (type) where.type = type;
      if (search) {
        where.description = { [Op.like]: `%${search}%` };
      }

      const { count, rows } = await FinRecurrence.findAndCountAll({
        where,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['next_due_date', 'ASC']],
        include: [
          { model: FinCategory, as: 'finCategory', attributes: ['id_code', 'name', 'color', 'icon'] },
          { model: FinCostCenter, as: 'finCostCenter', attributes: ['id_code', 'name', 'code'] },
          { model: Party, as: 'party', attributes: ['id_code', 'name'] }
        ]
      });

      res.json({
        total: count,
        pages: Math.ceil(count / limit),
        currentPage: parseInt(page),
        data: rows.map(r => ({
          ...r.toJSON(),
          id: r.id_code // Frontend compatibility
        }))
      });
    } catch (error) {
      console.error('Error fetching recurrences:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// === GET Recurrence by ID ===
router.get('/:id', authenticateToken, requireModule('financial'), requireStoreContext({ allowMissingForRoles: [] }), requireStoreAccess, async (req, res) => {
  try {
    const recurrence = await FinRecurrence.findOne({
      where: { id_code: req.params.id, store_id: req.storeId },
      include: [
        { model: FinCategory, as: 'finCategory' },
        { model: FinCostCenter, as: 'finCostCenter' },
        { model: Party, as: 'party' }
      ]
    });

    if (!recurrence) {
      return res.status(404).json({ error: 'Recurrence not found' });
    }

    res.json({
      ...recurrence.toJSON(),
      id: recurrence.id_code
    });
  } catch (error) {
    console.error('Error fetching recurrence:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// === UPDATE Recurrence ===
router.patch(
  '/:id',
  authenticateToken,
  requireModule('financial'),
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  [
    body('amount').optional().isFloat({ min: 0.01 }),
    body('day_of_month').optional().isInt({ min: 1, max: 31 }),
    body('status').optional().isIn(VALID_STATUS),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const recurrence = await FinRecurrence.findOne({
        where: { id_code: req.params.id, store_id: req.storeId }
      });

      if (!recurrence) {
        return res.status(404).json({ error: 'Recurrence not found' });
      }

      const fieldsToUpdate = [
        'description', 'amount', 'frequency', 'status',
        'start_date', 'end_date', 'next_due_date', 'day_of_month',
        'party_id', 'category_id', 'cost_center_id', 'type'
      ];

      fieldsToUpdate.forEach(field => {
        if (req.body[field] !== undefined) {
          recurrence[field] = req.body[field];
        }
      });

      recurrence.updated_by_user_id = req.user ? req.user.userId : null;
      await recurrence.save();

      // Reload to get associations if needed, or just return
      res.json({
        ...recurrence.toJSON(),
        id: recurrence.id_code
      });
    } catch (error) {
      console.error('Error updating recurrence:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// === DELETE Recurrence ===
router.delete('/:id', authenticateToken, requireModule('financial'), requireStoreContext({ allowMissingForRoles: [] }), requireStoreAccess, async (req, res) => {
  try {
    const recurrence = await FinRecurrence.findOne({
      where: { id_code: req.params.id, store_id: req.storeId }
    });

    if (!recurrence) {
      return res.status(404).json({ error: 'Recurrence not found' });
    }

    // Hard delete or Soft delete? 
    // Usually soft delete (status = finished) is better for history, 
    // but if user explicitly wants to delete, we can destroy.
    // Let's implement destroy for now, but maybe check for existing transactions?
    // Given the request didn't specify, I'll allow destroy but usually it's safer to just mark as finished.
    // Let's stick to standard DELETE = destroy for now.

    await recurrence.destroy();

    res.json({ message: 'Recurrence deleted successfully' });
  } catch (error) {
    console.error('Error deleting recurrence:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
