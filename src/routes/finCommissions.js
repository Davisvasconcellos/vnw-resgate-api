const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticateToken, requireModule } = require('../middlewares/auth');
const { requireStoreContext, requireStoreAccess } = require('../middlewares/storeContext');
const { requireStorePermission } = require('../middlewares/storePermissions');
const { FinancialCommission, Party, FinancialTransaction } = require('../models');
const { Op, fn, col } = require('sequelize');

const router = express.Router();

router.get(
  '/',
  authenticateToken,
  requireModule('financial'),
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  requireStorePermission(['financial:read', 'financial:write']),
  [
    query('status').optional().isIn(['pending', 'paid', 'canceled']),
    query('commission_seller_id').optional().isString(),
    query('source_transaction_id_code').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    try {
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
      const offset = (page - 1) * limit;

      const where = { store_id: req.storeId };

      if (req.query.status) where.status = req.query.status;
      if (req.query.commission_seller_id) where.commission_seller_id = req.query.commission_seller_id;
      if (req.query.source_transaction_id_code) where.source_transaction_id_code = req.query.source_transaction_id_code;

      const summaryWhere = { store_id: req.storeId };
      const summaryRows = await FinancialCommission.findAll({
        where: summaryWhere,
        attributes: [
          'status',
          [fn('COUNT', col('id')), 'count'],
          [fn('SUM', col('commission_amount')), 'total_amount']
        ],
        group: ['status']
      });

      const summary = {
        pending: { count: 0, amount: 0 },
        paid: { count: 0, amount: 0 }
      };

      for (const row of summaryRows) {
        const raw = row && typeof row.toJSON === 'function' ? row.toJSON() : row;
        const status = raw.status;
        const countVal = raw.count !== undefined ? Number(raw.count) : 0;
        const amountVal = raw.total_amount !== undefined && raw.total_amount !== null ? Number(raw.total_amount) : 0;

        if (status === 'pending') summary.pending = { count: countVal, amount: amountVal };
        if (status === 'paid') summary.paid = { count: countVal, amount: amountVal };
      }

      const { count, rows } = await FinancialCommission.findAndCountAll({
        where,
        limit,
        offset,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: Party,
            as: 'commissionSeller',
            attributes: ['id_code', 'name', 'trade_name', 'document', 'email']
          },
          {
            model: FinancialTransaction,
            as: 'sourceTransaction',
            attributes: ['id_code', 'type', 'description', 'amount', 'due_date', 'status', 'party_id', 'category_id', 'cost_center_id', 'nf']
          }
        ]
      });

      return res.json({
        success: true,
        meta: {
          total: count,
          page,
          limit,
          pages: Math.ceil(count / limit)
        },
        summary,
        data: rows.map((r) => ({
          ...r.toJSON(),
          id: r.id_code
        }))
      });
    } catch (error) {
      console.error('List commissions error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro ao listar comissões' });
    }
  }
);

module.exports = router;
