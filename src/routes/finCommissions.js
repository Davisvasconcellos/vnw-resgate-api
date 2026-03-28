const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticateToken, requireModule } = require('../middlewares/auth');
const { requireStoreContext, requireStoreAccess } = require('../middlewares/storeContext');
const { requireStorePermission } = require('../middlewares/storePermissions');
const { FinancialCommission, Party, FinancialTransaction, sequelize } = require('../models');
const { Op, fn, col, Transaction } = require('sequelize');

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
        data: rows.map((r) => {
          const plain = typeof r.toJSON === 'function' ? r.toJSON() : r;
          const sourceStatus = plain.sourceTransaction ? plain.sourceTransaction.status : null;
          const payable = !!plain.allow_advance_payment || sourceStatus === 'paid';
          return {
            ...plain,
            payable,
            id: plain.id_code
          };
        })
      });
    } catch (error) {
      console.error('List commissions error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro ao listar comissões' });
    }
  }
);

router.post(
  '/pay',
  authenticateToken,
  requireModule('financial'),
  requireStoreContext({ allowMissingForRoles: [] }),
  requireStoreAccess,
  requireStorePermission(['financial:write']),
  [
    body('commission_ids').isArray({ min: 1 }),
    body('commission_ids.*').isString(),
    body('bank_account_id').isString().notEmpty(),
    body('paid_at').optional({ nullable: true }).isISO8601(),
    body('payment_method').optional({ nullable: true }).isIn(['cash', 'pix', 'credit_card', 'debit_card', 'bank_transfer', 'boleto'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    const formatMoney = (value) => {
      const n = Number(value);
      if (Number.isNaN(n)) return null;
      return n.toFixed(2);
    };

    const formatRate = (value) => {
      const n = Number(value);
      if (Number.isNaN(n)) return null;
      if (Number.isInteger(n)) return String(n);
      return String(Number(n.toFixed(4)));
    };

    const paidAt = req.body.paid_at ? String(req.body.paid_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const paymentMethod = req.body.payment_method || 'bank_transfer';
    const bankAccountId = String(req.body.bank_account_id);
    const commissionIds = req.body.commission_ids.map((v) => String(v));

    try {
      const result = await sequelize.transaction(async (t) => {
        const commissions = await FinancialCommission.findAll({
          where: { store_id: req.storeId, id_code: { [Op.in]: commissionIds } },
          transaction: t,
          lock: { level: Transaction.LOCK.UPDATE, of: FinancialCommission },
          include: [
            {
              model: Party,
              as: 'commissionSeller',
              attributes: ['id_code', 'name', 'trade_name']
            },
            {
              model: FinancialTransaction,
              as: 'sourceTransaction',
              attributes: ['id_code', 'nf', 'amount', 'description', 'status']
            }
          ]
        });

        const byId = new Map(commissions.map((c) => [c.id_code, c]));

        const paid = [];
        const skipped = [];
        const notFound = [];

        for (const id of commissionIds) {
          const commission = byId.get(id);
          if (!commission) {
            notFound.push(id);
            continue;
          }

          if (commission.status === 'paid' || commission.paid_transaction_id_code) {
            skipped.push({ id_code: commission.id_code, reason: 'already_paid' });
            continue;
          }

          const sourceStatus = commission.sourceTransaction ? commission.sourceTransaction.status : null;
          const isPayable = !!commission.allow_advance_payment || sourceStatus === 'paid';
          if (!isPayable) {
            skipped.push({ id_code: commission.id_code, reason: 'not_payable' });
            continue;
          }

          const sellerName =
            (commission.commissionSeller && (commission.commissionSeller.trade_name || commission.commissionSeller.name)) ||
            commission.commission_seller_id;

          const baseAmount = commission.sourceTransaction ? formatMoney(commission.sourceTransaction.amount) : null;
          const commissionAmount = formatMoney(commission.commission_amount) || formatMoney(0);
          const rateStr = formatRate(commission.commission_rate);

          const refLabel = commission.sourceTransaction && commission.sourceTransaction.nf
            ? `NF ${commission.sourceTransaction.nf}`
            : `Ref ${commission.source_transaction_id_code}`;

          const parts = [
            `Comissão - ${sellerName}`,
            refLabel,
            baseAmount ? `Base ${baseAmount}` : null,
            commission.commission_type === 'percentage' && rateStr ? `Taxa ${rateStr}%` : null,
            `Comissão ${commissionAmount}`
          ].filter(Boolean);

          const txnDescription = parts.join(' | ');

          const txn = await FinancialTransaction.create(
            {
              store_id: req.storeId,
              type: 'PAYABLE',
              description: txnDescription,
              amount: commission.commission_amount,
              currency: 'BRL',
              due_date: paidAt,
              paid_at: paidAt,
              party_id: commission.commission_seller_id,
              status: 'paid',
              is_paid: true,
              payment_method: paymentMethod,
              bank_account_id: bankAccountId,
              created_by_user_id: req.user.userId,
              updated_by_user_id: null,
              is_deleted: false
            },
            { transaction: t }
          );

          await commission.update(
            {
              status: 'paid',
              paid_transaction_id_code: txn.id_code,
              paid_bank_account_id: bankAccountId,
              paid_at: paidAt
            },
            { transaction: t }
          );

          paid.push({ id_code: commission.id_code, paid_transaction_id_code: txn.id_code });
        }

        return { paid, skipped, notFound };
      });

      return res.json({
        success: true,
        data: {
          paid_count: result.paid.length,
          skipped_count: result.skipped.length,
          not_found_count: result.notFound.length,
          paid: result.paid,
          skipped: result.skipped,
          not_found: result.notFound
        }
      });
    } catch (error) {
      console.error('Pay commissions error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro ao pagar comissões' });
    }
  }
);

module.exports = router;
