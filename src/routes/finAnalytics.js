const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticateToken, requireModule } = require('../middlewares/auth');
const {
  FinancialTransaction,
  FinancialCommission,
  Party,
  FinCategory,
  FinCostCenter,
  FinTag,
  FinRecurrence,
  BankAccount,
  Store,
  StoreMember,
  StoreUser,
  sequelize
} = require('../models');
const { Op, fn, col, literal } = require('sequelize');

const router = express.Router();

const parseStoreIds = (s) => {
  if (!s) return [];
  if (Array.isArray(s)) return s.filter(Boolean);
  return String(s).split(',').map(v => v.trim()).filter(Boolean);
};

const highPrivilegeRoles = ['master', 'masteradmin'];

const toDateOnly = (value) => String(value).slice(0, 10);

const parseDateUtc = (s) => new Date(`${toDateOnly(s)}T00:00:00Z`);

const addDaysUtc = (date, days) => new Date(date.getTime() + (days * 86400000));

const diffDaysInclusiveUtc = (start, end) => {
  const s = parseDateUtc(start);
  const e = parseDateUtc(end);
  return Math.floor((e.getTime() - s.getTime()) / 86400000) + 1;
};

const formatDateOnlyUtc = (date) => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getPreviousPeriod = (startDate, endDate) => {
  const days = diffDaysInclusiveUtc(startDate, endDate);
  const prevEnd = addDaysUtc(parseDateUtc(startDate), -1);
  const prevStart = addDaysUtc(prevEnd, -(days - 1));
  return { prev_start_date: formatDateOnlyUtc(prevStart), prev_end_date: formatDateOnlyUtc(prevEnd) };
};

const safeDeltaPct = (current, previous) => {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return null;
  return parseFloat((((c - p) / p) * 100).toFixed(2));
};

const computeKpis = async ({ dateMode, startDate, endDate, txBaseWhere }) => {
  const paidWhereCash = {
    ...txBaseWhere,
    status: 'paid',
    paid_at: { [Op.between]: [startDate, endDate] }
  };

  const plannedWhereCompetence = {
    ...txBaseWhere,
    status: { [Op.ne]: 'canceled' },
    due_date: { [Op.between]: [startDate, endDate] }
  };

  const openStatuses = ['pending', 'scheduled', 'approved', 'overdue', 'provisioned'];
  const openWhere = {
    ...txBaseWhere,
    status: { [Op.in]: openStatuses },
    due_date: { [Op.between]: [startDate, endDate] }
  };

  const overdueWhere = {
    ...txBaseWhere,
    status: 'overdue',
    due_date: { [Op.between]: [startDate, endDate] }
  };

  const isCash = dateMode === 'cash';

  const baseReceivedWhere = isCash
    ? { ...paidWhereCash, type: 'RECEIVABLE' }
    : { ...plannedWhereCompetence, type: 'RECEIVABLE' };
  const basePaidWhere = isCash
    ? { ...paidWhereCash, type: 'PAYABLE' }
    : { ...plannedWhereCompetence, type: 'PAYABLE' };

  const [sumReceived, sumPaid, sumReceivableOpen, sumPayableOpen, sumOverdueRecv, sumOverduePay] = await Promise.all([
    FinancialTransaction.findAll({
      where: baseReceivedWhere,
      attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
      raw: true
    }),
    FinancialTransaction.findAll({
      where: basePaidWhere,
      attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
      raw: true
    }),
    FinancialTransaction.findAll({
      where: { ...openWhere, type: 'RECEIVABLE' },
      attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
      raw: true
    }),
    FinancialTransaction.findAll({
      where: { ...openWhere, type: 'PAYABLE' },
      attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
      raw: true
    }),
    FinancialTransaction.findAll({
      where: { ...overdueWhere, type: 'RECEIVABLE' },
      attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
      raw: true
    }),
    FinancialTransaction.findAll({
      where: { ...overdueWhere, type: 'PAYABLE' },
      attributes: [[fn('COALESCE', fn('SUM', col('amount')), 0), 'total']],
      raw: true
    })
  ]);

  const total_received = parseFloat(sumReceived[0]?.total || 0);
  const total_paid = parseFloat(sumPaid[0]?.total || 0);
  const receivable_open = parseFloat(sumReceivableOpen[0]?.total || 0);
  const payable_open = parseFloat(sumPayableOpen[0]?.total || 0);
  const overdue_receivable = parseFloat(sumOverdueRecv[0]?.total || 0);
  const overdue_payable = parseFloat(sumOverduePay[0]?.total || 0);

  return {
    total_received,
    total_paid,
    balance: parseFloat((total_received - total_paid).toFixed(2)),
    receivable_open,
    payable_open,
    overdue_total: parseFloat((overdue_receivable + overdue_payable).toFixed(2)),
    overdue_receivable,
    overdue_payable
  };
};

const resolveAccessibleStoreIds = async (user, requestedStoreIds) => {
  const role = user?.role;
  const userId = user?.userId;

  if (!userId) return [];

  if (requestedStoreIds && requestedStoreIds.length) {
    const stores = await Store.findAll({
      where: { id_code: { [Op.in]: requestedStoreIds } },
      attributes: ['id', 'id_code', 'owner_id'],
      raw: true
    });

    const found = new Set(stores.map(s => s.id_code));
    const missing = requestedStoreIds.filter(id => !found.has(id));
    if (missing.length) {
      const err = new Error('stores_not_found');
      err.code = 'stores_not_found';
      err.missing = missing;
      throw err;
    }

    if (highPrivilegeRoles.includes(role)) {
      const map = new Map(stores.map(s => [s.id_code, s]));
      return requestedStoreIds.map(id => map.get(id).id_code);
    }

    const storeDbIds = stores.map(s => s.id);
    const owned = new Set(stores.filter(s => String(s.owner_id) === String(userId)).map(s => s.id));
    const [memberRows, legacyRows] = await Promise.all([
      StoreMember.findAll({
        where: { store_id: { [Op.in]: storeDbIds }, user_id: userId, status: 'active' },
        attributes: ['store_id'],
        raw: true
      }),
      StoreUser.findAll({
        where: { store_id: { [Op.in]: storeDbIds }, user_id: userId },
        attributes: ['store_id'],
        raw: true
      })
    ]);

    const accessibleDbIds = new Set([
      ...Array.from(owned),
      ...memberRows.map(r => r.store_id),
      ...legacyRows.map(r => r.store_id)
    ]);

    const denied = stores
      .filter(s => !accessibleDbIds.has(s.id))
      .map(s => s.id_code);

    if (denied.length) {
      const err = new Error('stores_forbidden');
      err.code = 'stores_forbidden';
      err.denied = denied;
      throw err;
    }

    const storesById = new Map(stores.map(s => [s.id_code, s]));
    return requestedStoreIds.map(id => storesById.get(id).id_code);
  }

  if (highPrivilegeRoles.includes(role)) {
    const allStores = await Store.findAll({ attributes: ['id_code'], raw: true });
    return allStores.map(s => s.id_code);
  }

  const [ownedStores, memberStores, legacyStores] = await Promise.all([
    Store.findAll({ where: { owner_id: userId }, attributes: ['id_code'], raw: true }),
    StoreMember.findAll({ where: { user_id: userId, status: 'active' }, attributes: ['store_id'], raw: true }),
    StoreUser.findAll({ where: { user_id: userId }, attributes: ['store_id'], raw: true })
  ]);

  const storeDbIds = Array.from(new Set([
    ...memberStores.map(r => r.store_id),
    ...legacyStores.map(r => r.store_id)
  ]));

  const linkedStores = storeDbIds.length
    ? await Store.findAll({ where: { id: { [Op.in]: storeDbIds } }, attributes: ['id_code'], raw: true })
    : [];

  const unique = new Set([
    ...ownedStores.map(s => s.id_code),
    ...linkedStores.map(s => s.id_code)
  ]);

  return Array.from(unique);
};

router.get(
  '/dashboard',
  authenticateToken,
  requireModule('financial'),
  [
    query('start_date').isISO8601(),
    query('end_date').isISO8601(),
    query('date_mode').optional().isIn(['cash', 'competence']).default('cash'),
    query('store_ids').optional().isString(),
    query('limit_top').optional().isInt({ min: 1, max: 50 }).toInt()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    try {
      const startDate = toDateOnly(req.query.start_date);
      const endDate = toDateOnly(req.query.end_date);
      const dateMode = req.query.date_mode || 'cash';
      const requestedStoreIds = parseStoreIds(req.query.store_ids);
      let storeIds = [];
      try {
        storeIds = await resolveAccessibleStoreIds(req.user, requestedStoreIds);
      } catch (e) {
        if (e.code === 'stores_not_found') {
          return res.status(404).json({ error: 'Not Found', message: 'Loja não encontrada', missing: e.missing });
        }
        if (e.code === 'stores_forbidden') {
          return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para acessar uma ou mais lojas', denied: e.denied });
        }
        throw e;
      }

      const effectiveStoreIds = storeIds.length ? storeIds : ['__no_access__'];
      const topLimit = req.query.limit_top || 10;

      const txBaseWhere = { is_deleted: false };
      txBaseWhere.store_id = { [Op.in]: effectiveStoreIds };

      const kpis = await computeKpis({ dateMode, startDate, endDate, txBaseWhere });
      const prev = getPreviousPeriod(startDate, endDate);
      const prevKpis = await computeKpis({
        dateMode,
        startDate: prev.prev_start_date,
        endDate: prev.prev_end_date,
        txBaseWhere
      });

      const compare_to_previous = {
        previous_scope: {
          start_date: prev.prev_start_date,
          end_date: prev.prev_end_date,
          date_mode: dateMode
        },
        previous_kpis: prevKpis,
        delta: {
          total_received: parseFloat((kpis.total_received - prevKpis.total_received).toFixed(2)),
          total_paid: parseFloat((kpis.total_paid - prevKpis.total_paid).toFixed(2)),
          balance: parseFloat((kpis.balance - prevKpis.balance).toFixed(2)),
          overdue_total: parseFloat((kpis.overdue_total - prevKpis.overdue_total).toFixed(2))
        },
        delta_pct: {
          total_received: safeDeltaPct(kpis.total_received, prevKpis.total_received),
          total_paid: safeDeltaPct(kpis.total_paid, prevKpis.total_paid),
          balance: safeDeltaPct(kpis.balance, prevKpis.balance),
          overdue_total: safeDeltaPct(kpis.overdue_total, prevKpis.overdue_total)
        }
      };

      const actualPaidWhere = {
        ...txBaseWhere,
        status: 'paid',
        paid_at: { [Op.between]: [startDate, endDate] }
      };

      const plannedDueWhere = {
        ...txBaseWhere,
        status: { [Op.ne]: 'canceled' },
        due_date: { [Op.between]: [startDate, endDate] }
      };

      const actualSeries = await FinancialTransaction.findAll({
        where: actualPaidWhere,
        attributes: [
          [fn('DATE', col('paid_at')), 'd'],
          'type',
          [fn('SUM', col('amount')), 'total']
        ],
        group: [literal('1'), 'type'],
        raw: true
      });

      const plannedSeries = await FinancialTransaction.findAll({
        where: plannedDueWhere,
        attributes: [
          [fn('DATE', col('due_date')), 'd'],
          'type',
          [fn('SUM', col('amount')), 'total']
        ],
        group: [literal('1'), 'type'],
        raw: true
      });

      const seriesMap = new Map();
      const ensure = (d) => {
        if (!seriesMap.has(d)) {
          seriesMap.set(d, {
            received_actual: 0,
            paid_actual: 0,
            received_planned: 0,
            paid_planned: 0
          });
        }
        return seriesMap.get(d);
      };

      for (const row of actualSeries) {
        const d = row.d;
        const t = row.type;
        const val = parseFloat(row.total || 0);
        const entry = ensure(d);
        if (t === 'RECEIVABLE') entry.received_actual += val;
        if (t === 'PAYABLE') entry.paid_actual += val;
      }

      for (const row of plannedSeries) {
        const d = row.d;
        const t = row.type;
        const val = parseFloat(row.total || 0);
        const entry = ensure(d);
        if (t === 'RECEIVABLE') entry.received_planned += val;
        if (t === 'PAYABLE') entry.paid_planned += val;
      }

      const parseDate = (s) => new Date(s + 'T00:00:00Z');
      const dates = [];
      let dt = parseDate(startDate);
      const end = parseDate(endDate);
      while (dt <= end) {
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const day = String(dt.getUTCDate()).padStart(2, '0');
        const key = `${y}-${m}-${day}`;
        const entry = seriesMap.get(key) || { received_actual: 0, paid_actual: 0, received_planned: 0, paid_planned: 0 };
        dates.push({
          date: key,
          received_actual: parseFloat(entry.received_actual.toFixed(2)),
          paid_actual: parseFloat(entry.paid_actual.toFixed(2)),
          received_planned: parseFloat(entry.received_planned.toFixed(2)),
          paid_planned: parseFloat(entry.paid_planned.toFixed(2))
        });
        dt = new Date(dt.getTime() + 86400000);
      }

      const topCategoriesRows = await FinancialTransaction.findAll({
        where: dateMode === 'cash'
          ? { ...actualPaidWhere, type: 'PAYABLE' }
          : { ...plannedDueWhere, type: 'PAYABLE' },
        attributes: [
          'category_id',
          [fn('SUM', col('amount')), 'total_paid']
        ],
        group: ['category_id'],
        order: [[literal('total_paid'), 'DESC']],
        limit: topLimit,
        raw: true
      });

      const topCustomersRows = await FinancialTransaction.findAll({
        where: dateMode === 'cash'
          ? { ...actualPaidWhere, type: 'RECEIVABLE' }
          : { ...plannedDueWhere, type: 'RECEIVABLE' },
        attributes: [
          'party_id',
          [fn('SUM', col('amount')), 'total_received']
        ],
        group: ['party_id'],
        order: [[literal('total_received'), 'DESC']],
        limit: topLimit,
        raw: true
      });

      const categoryIds = Array.from(new Set(topCategoriesRows.map(r => r.category_id).filter(Boolean)));
      const partyIds = Array.from(new Set(topCustomersRows.map(r => r.party_id).filter(Boolean)));

      const [categories, parties] = await Promise.all([
        categoryIds.length
          ? FinCategory.findAll({ where: { id_code: { [Op.in]: categoryIds } }, attributes: ['id_code', 'name'], raw: true })
          : [],
        partyIds.length
          ? Party.findAll({ where: { id_code: { [Op.in]: partyIds } }, attributes: ['id_code', 'name', 'trade_name'], raw: true })
          : []
      ]);

      const categoryNameById = new Map(categories.map(c => [c.id_code, c.name]));
      const partyNameById = new Map(parties.map(p => [p.id_code, p.trade_name || p.name]));

      const topExpenseCategories = topCategoriesRows.map((r) => ({
        category_id: r.category_id || null,
        category_name: r.category_id ? (categoryNameById.get(r.category_id) || r.category_id) : null,
        total_paid: parseFloat(r.total_paid || 0)
      }));

      const topCustomers = topCustomersRows.map((r) => ({
        party_id: r.party_id || null,
        party_name: r.party_id ? (partyNameById.get(r.party_id) || r.party_id) : null,
        total_received: parseFloat(r.total_received || 0)
      }));

      const commissionsPendingRows = await FinancialCommission.findAll({
        where: {
          status: 'pending',
          store_id: { [Op.in]: effectiveStoreIds },
          created_at: { [Op.between]: [startDate, endDate] }
        },
        attributes: [[fn('COUNT', col('id')), 'cnt'], [fn('COALESCE', fn('SUM', col('commission_amount')), 0), 'amt']],
        raw: true
      });
      const commissionsPaidRows = await FinancialCommission.findAll({
        where: {
          status: 'paid',
          store_id: { [Op.in]: effectiveStoreIds },
          paid_at: { [Op.between]: [startDate, endDate] }
        },
        attributes: [[fn('COUNT', col('id')), 'cnt'], [fn('COALESCE', fn('SUM', col('commission_amount')), 0), 'amt']],
        raw: true
      });

      const commissions = {
        pending_amount: parseFloat(commissionsPendingRows[0]?.amt || 0),
        pending_count: parseInt(commissionsPendingRows[0]?.cnt || 0, 10),
        paid_amount: parseFloat(commissionsPaidRows[0]?.amt || 0),
        paid_count: parseInt(commissionsPaidRows[0]?.cnt || 0, 10)
      };

      const pendingCommissionsSampleLimit = 20;
      const pendingCommissionsRows = await FinancialCommission.findAll({
        where: {
          status: 'pending',
          store_id: { [Op.in]: effectiveStoreIds },
          created_at: { [Op.between]: [startDate, endDate] }
        },
        attributes: [
          'id_code',
          'store_id',
          'commission_seller_id',
          'commission_type',
          'commission_rate',
          'commission_amount',
          'allow_advance_payment',
          'source_transaction_id_code',
          'created_at'
        ],
        include: [
          {
            model: FinancialTransaction,
            as: 'sourceTransaction',
            required: false,
            attributes: ['id_code', 'type', 'status', 'amount', 'paid_at', 'due_date', 'description', 'nf']
          },
          {
            model: Party,
            as: 'commissionSeller',
            required: false,
            attributes: ['id_code', 'name', 'trade_name']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: pendingCommissionsSampleLimit
      });

      const commissions_pending_list = {
        sample_limit: pendingCommissionsSampleLimit,
        items: pendingCommissionsRows.map((row) => {
          const c = typeof row.toJSON === 'function' ? row.toJSON() : row;
          const sellerName = c.commissionSeller
            ? (c.commissionSeller.trade_name || c.commissionSeller.name || c.commissionSeller.id_code)
            : (c.commission_seller_id || null);
          const sourceStatus = c.sourceTransaction ? c.sourceTransaction.status : null;
          const payable = !!c.allow_advance_payment || sourceStatus === 'paid';
          return {
            commission_id_code: c.id_code,
            store_id: c.store_id,
            created_at: c.created_at,
            commission_amount: c.commission_amount !== null && c.commission_amount !== undefined ? parseFloat(c.commission_amount) : null,
            commission_type: c.commission_type || null,
            commission_rate: c.commission_rate !== null && c.commission_rate !== undefined ? parseFloat(c.commission_rate) : null,
            allow_advance_payment: !!c.allow_advance_payment,
            payable,
            seller: {
              id_code: c.commission_seller_id || null,
              name: sellerName
            },
            source_transaction: c.sourceTransaction ? {
              id_code: c.sourceTransaction.id_code,
              status: c.sourceTransaction.status,
              amount: c.sourceTransaction.amount,
              due_date: c.sourceTransaction.due_date,
              paid_at: c.sourceTransaction.paid_at,
              description: c.sourceTransaction.description,
              nf: c.sourceTransaction.nf || null
            } : null
          };
        })
      };

      const paymentMethodRows = await FinancialTransaction.findAll({
        where: actualPaidWhere,
        attributes: [
          'type',
          [fn('COALESCE', col('payment_method'), literal(`'none'`)), 'payment_method'],
          [fn('SUM', col('amount')), 'total_amount'],
          [fn('COUNT', col('id')), 'count']
        ],
        group: ['type', literal('payment_method')],
        raw: true
      });

      const payment_methods = {
        receivable: [],
        payable: []
      };
      for (const row of paymentMethodRows) {
        const list = row.type === 'RECEIVABLE' ? payment_methods.receivable : row.type === 'PAYABLE' ? payment_methods.payable : null;
        if (!list) continue;
        list.push({
          method: row.payment_method || 'none',
          total_amount: parseFloat(row.total_amount || 0),
          count: parseInt(row.count || 0, 10)
        });
      }
      payment_methods.receivable.sort((a, b) => b.total_amount - a.total_amount);
      payment_methods.payable.sort((a, b) => b.total_amount - a.total_amount);

      const bankAccountRows = await FinancialTransaction.findAll({
        where: actualPaidWhere,
        attributes: [
          'bank_account_id',
          'type',
          [fn('SUM', col('amount')), 'total_amount'],
          [fn('COUNT', col('id')), 'count']
        ],
        group: ['bank_account_id', 'type'],
        raw: true
      });

      const bankAccountIds = Array.from(new Set(bankAccountRows.map(r => r.bank_account_id).filter(Boolean)));
      const bankAccounts = bankAccountIds.length
        ? await BankAccount.findAll({
          where: { id_code: { [Op.in]: bankAccountIds } },
          attributes: ['id_code', 'name', 'bank_name', 'type', 'is_active'],
          raw: true
        })
        : [];
      const bankAccountById = new Map(bankAccounts.map(a => [a.id_code, a]));

      const bank_accounts = new Map();
      const ensureBank = (id) => {
        const key = id || '__none__';
        if (!bank_accounts.has(key)) {
          const meta = id ? bankAccountById.get(id) : null;
          bank_accounts.set(key, {
            bank_account_id: id || null,
            bank_account_name: meta ? meta.name : (id || 'Sem conta'),
            bank_name: meta ? meta.bank_name : null,
            totals: { received: 0, paid: 0, net: 0 },
            counts: { received: 0, paid: 0 }
          });
        }
        return bank_accounts.get(key);
      };
      for (const row of bankAccountRows) {
        const entry = ensureBank(row.bank_account_id);
        const amt = parseFloat(row.total_amount || 0);
        const cnt = parseInt(row.count || 0, 10);
        if (row.type === 'RECEIVABLE') {
          entry.totals.received += amt;
          entry.counts.received += cnt;
        }
        if (row.type === 'PAYABLE') {
          entry.totals.paid += amt;
          entry.counts.paid += cnt;
        }
      }
      const bank_accounts_breakdown = Array.from(bank_accounts.values()).map((b) => {
        b.totals.net = b.totals.received - b.totals.paid;
        b.totals.received = parseFloat(b.totals.received.toFixed(2));
        b.totals.paid = parseFloat(b.totals.paid.toFixed(2));
        b.totals.net = parseFloat(b.totals.net.toFixed(2));
        return b;
      }).sort((a, b) => (b.totals.received + b.totals.paid) - (a.totals.received + a.totals.paid));

      const tagsBaseWhere = dateMode === 'cash'
        ? { ...actualPaidWhere }
        : { ...plannedDueWhere };

      const tagsBaseDateField = dateMode === 'cash' ? 'paid_at' : 'due_date';
      const tagsWhereSql = `
        t.is_deleted = false
        AND t.store_id IN (:store_ids)
        AND ${dateMode === 'cash'
          ? `t.status = 'paid' AND t.paid_at BETWEEN :start_date AND :end_date`
          : `t.status <> 'canceled' AND t.due_date BETWEEN :start_date AND :end_date`
        }
      `;

      const [[tagsTotalRow]] = await sequelize.query(
        `
          SELECT COUNT(*)::int AS total_count,
                 COALESCE(SUM(t.amount), 0)::numeric AS total_amount
          FROM financial_transactions t
          WHERE ${tagsWhereSql};
        `,
        { replacements: { store_ids: effectiveStoreIds, start_date: startDate, end_date: endDate } }
      );

      const [[tagsTaggedRow]] = await sequelize.query(
        `
          SELECT COUNT(DISTINCT t.id_code)::int AS tagged_count
          FROM financial_transactions t
          INNER JOIN financial_transaction_tags ftt ON ftt.transaction_id = t.id_code
          WHERE ${tagsWhereSql};
        `,
        { replacements: { store_ids: effectiveStoreIds, start_date: startDate, end_date: endDate } }
      );

      const tagsTotalCount = Number(tagsTotalRow?.total_count || 0);
      const tagsTaggedCount = Number(tagsTaggedRow?.tagged_count || 0);
      const tagsUntaggedCount = Math.max(tagsTotalCount - tagsTaggedCount, 0);
      const tagsCoveragePct = tagsTotalCount ? parseFloat(((tagsTaggedCount / tagsTotalCount) * 100).toFixed(2)) : 0;

      const [topTagRows] = await sequelize.query(
        `
          SELECT ftt.tag_id AS tag_id,
                 COUNT(DISTINCT t.id_code)::int AS tx_count,
                 COALESCE(SUM(t.amount), 0)::numeric AS total_amount
          FROM financial_transaction_tags ftt
          INNER JOIN financial_transactions t ON t.id_code = ftt.transaction_id
          WHERE ${tagsWhereSql}
          GROUP BY ftt.tag_id
          ORDER BY total_amount DESC
          LIMIT :limit_top;
        `,
        { replacements: { store_ids: effectiveStoreIds, start_date: startDate, end_date: endDate, limit_top: topLimit } }
      );

      const topTagIds = topTagRows.map(r => r.tag_id).filter(Boolean);
      const tagsMeta = topTagIds.length
        ? await FinTag.findAll({
          where: { id_code: { [Op.in]: topTagIds } },
          attributes: ['id_code', 'name', 'color'],
          raw: true
        })
        : [];
      const tagMetaById = new Map(tagsMeta.map(t => [t.id_code, t]));

      const tags = {
        coverage_pct: tagsCoveragePct,
        totals: {
          total_count: tagsTotalCount,
          tagged_count: tagsTaggedCount,
          untagged_count: tagsUntaggedCount,
          total_amount: parseFloat(tagsTotalRow?.total_amount || 0)
        },
        top: topTagRows.map(r => {
          const meta = tagMetaById.get(r.tag_id);
          return {
            tag_id: r.tag_id,
            tag_name: meta ? meta.name : r.tag_id,
            color: meta ? meta.color : null,
            tx_count: Number(r.tx_count || 0),
            total_amount: parseFloat(r.total_amount || 0)
          };
        })
      };

      const untaggedRowWhereSql = `
        ${tagsWhereSql}
        AND NOT EXISTS (
          SELECT 1 FROM financial_transaction_tags ftt
          WHERE ftt.transaction_id = t.id_code
        )
      `;
      const [[untaggedSumRow]] = await sequelize.query(
        `
          SELECT COALESCE(SUM(t.amount), 0)::numeric AS total_amount
          FROM financial_transactions t
          WHERE ${untaggedRowWhereSql};
        `,
        { replacements: { store_ids: effectiveStoreIds, start_date: startDate, end_date: endDate } }
      );
      tags.untagged = {
        tag_id: null,
        tag_name: 'Sem tag',
        color: null,
        tx_count: tagsUntaggedCount,
        total_amount: parseFloat(untaggedSumRow?.total_amount || 0)
      };

      const recurrences = await FinRecurrence.findAll({
        where: {
          store_id: { [Op.in]: effectiveStoreIds },
          status: 'active',
          next_due_date: { [Op.lte]: endDate },
          [Op.or]: [
            { end_date: null },
            { end_date: { [Op.gte]: startDate } }
          ]
        },
        attributes: [
          'id_code',
          'store_id',
          'type',
          'description',
          'amount',
          'frequency',
          'start_date',
          'end_date',
          'next_due_date',
          'day_of_month',
          'party_id',
          'category_id',
          'cost_center_id'
        ],
        raw: true
      });

      const forecastByMonth = new Map();
      const bumpForecast = (dateOnly, type, amount) => {
        const month = dateOnly.slice(0, 7);
        if (!forecastByMonth.has(month)) {
          forecastByMonth.set(month, { month, receivable: 0, payable: 0 });
        }
        const entry = forecastByMonth.get(month);
        if (type === 'RECEIVABLE') entry.receivable += amount;
        if (type === 'PAYABLE') entry.payable += amount;
      };

      const addMonthsUtc = (date, months) => {
        const y = date.getUTCFullYear();
        const m = date.getUTCMonth();
        const d = date.getUTCDate();
        const base = new Date(Date.UTC(y, m + months, 1));
        const daysInMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
        const day = Math.min(d, daysInMonth);
        return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day));
      };

      const setDayOfMonthUtc = (date, dayOfMonth) => {
        const y = date.getUTCFullYear();
        const m = date.getUTCMonth();
        const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const day = Math.min(Math.max(parseInt(dayOfMonth || 1, 10), 1), daysInMonth);
        return new Date(Date.UTC(y, m, day));
      };

      for (const rec of recurrences) {
        const amount = parseFloat(rec.amount || 0);
        if (!amount) continue;
        const rangeStart = parseDateUtc(startDate);
        const rangeEnd = parseDateUtc(endDate);
        const hardEnd = rec.end_date ? parseDateUtc(rec.end_date) : null;
        const capEnd = hardEnd && hardEnd < rangeEnd ? hardEnd : rangeEnd;

        let cursor = rec.next_due_date ? parseDateUtc(rec.next_due_date) : rangeStart;
        if (cursor < rangeStart) {
          cursor = rangeStart;
        }
        if (rec.frequency === 'monthly') {
          cursor = setDayOfMonthUtc(cursor, rec.day_of_month);
          if (cursor < rangeStart) cursor = addMonthsUtc(cursor, 1);
        }
        if (rec.frequency === 'yearly') {
          if (cursor < rangeStart) cursor = rangeStart;
        }

        while (cursor <= capEnd) {
          const dateOnly = formatDateOnlyUtc(cursor);
          bumpForecast(dateOnly, rec.type, amount);
          if (rec.frequency === 'weekly') cursor = addDaysUtc(cursor, 7);
          else if (rec.frequency === 'monthly') cursor = addMonthsUtc(cursor, 1);
          else if (rec.frequency === 'yearly') cursor = new Date(Date.UTC(cursor.getUTCFullYear() + 1, cursor.getUTCMonth(), cursor.getUTCDate()));
          else cursor = addMonthsUtc(cursor, 1);
        }
      }

      const forecast_monthly = Array.from(forecastByMonth.values())
        .map((m) => ({
          month: m.month,
          receivable: parseFloat(m.receivable.toFixed(2)),
          payable: parseFloat(m.payable.toFixed(2)),
          net: parseFloat((m.receivable - m.payable).toFixed(2))
        }))
        .sort((a, b) => a.month.localeCompare(b.month));

      const forecast_totals = forecast_monthly.reduce(
        (acc, row) => {
          acc.receivable += row.receivable;
          acc.payable += row.payable;
          return acc;
        },
        { receivable: 0, payable: 0 }
      );
      forecast_totals.receivable = parseFloat(forecast_totals.receivable.toFixed(2));
      forecast_totals.payable = parseFloat(forecast_totals.payable.toFixed(2));

      const forecast_recurrences = {
        totals: {
          receivable: forecast_totals.receivable,
          payable: forecast_totals.payable,
          net: parseFloat((forecast_totals.receivable - forecast_totals.payable).toFixed(2))
        },
        monthly: forecast_monthly
      };

      const paidCommissionsForAudit = await FinancialCommission.findAll({
        where: {
          status: 'paid',
          store_id: { [Op.in]: effectiveStoreIds },
          paid_at: { [Op.between]: [startDate, endDate] }
        },
        attributes: [
          'id_code',
          'store_id',
          'commission_seller_id',
          'commission_type',
          'commission_rate',
          'commission_amount',
          'allow_advance_payment',
          'source_transaction_id_code',
          'paid_transaction_id_code',
          'paid_at',
          'created_at'
        ],
        include: [
          {
            model: FinancialTransaction,
            as: 'sourceTransaction',
            required: false,
            attributes: ['id_code', 'type', 'status', 'is_deleted', 'amount', 'paid_at', 'due_date', 'description', 'nf']
          },
          {
            model: FinancialTransaction,
            as: 'paidTransaction',
            required: false,
            attributes: ['id_code', 'type', 'status', 'is_deleted', 'amount', 'paid_at', 'due_date', 'description']
          },
          {
            model: Party,
            as: 'commissionSeller',
            required: false,
            attributes: ['id_code', 'name', 'trade_name']
          }
        ],
        order: [['paid_at', 'DESC'], ['created_at', 'DESC']],
        limit: 50
      });

      const commission_inconsistencies = {
        sample_limit: 50,
        items: [],
        counts: {}
      };

      const bump = (key) => {
        commission_inconsistencies.counts[key] = (commission_inconsistencies.counts[key] || 0) + 1;
      };

      for (const row of paidCommissionsForAudit) {
        const c = typeof row.toJSON === 'function' ? row.toJSON() : row;
        const issues = [];

        if (!c.source_transaction_id_code) {
          issues.push('missing_source_transaction_id_code');
        }
        if (!c.paid_transaction_id_code) {
          issues.push('missing_paid_transaction_id_code');
        }

        if (!c.sourceTransaction) {
          issues.push('missing_source_transaction');
        } else {
          if (c.sourceTransaction.is_deleted) issues.push('source_transaction_deleted');
          if (c.sourceTransaction.status === 'canceled') issues.push('source_transaction_canceled');
          if (!c.allow_advance_payment && c.sourceTransaction.status !== 'paid') issues.push('source_transaction_not_paid');
          if (c.sourceTransaction.type && c.sourceTransaction.type !== 'RECEIVABLE') issues.push('source_transaction_not_receivable');
        }

        if (!c.paidTransaction) {
          issues.push('missing_paid_transaction');
        } else {
          if (c.paidTransaction.is_deleted) issues.push('paid_transaction_deleted');
          if (c.paidTransaction.status !== 'paid') issues.push('paid_transaction_not_paid');
          if (c.paidTransaction.type && c.paidTransaction.type !== 'PAYABLE') issues.push('paid_transaction_not_payable');
        }

        if (!issues.length) continue;

        for (const issue of issues) bump(issue);

        const sellerName = c.commissionSeller
          ? (c.commissionSeller.trade_name || c.commissionSeller.name || c.commissionSeller.id_code)
          : (c.commission_seller_id || null);

        commission_inconsistencies.items.push({
          commission_id_code: c.id_code,
          store_id: c.store_id,
          paid_at: c.paid_at || null,
          commission_amount: c.commission_amount !== null && c.commission_amount !== undefined ? parseFloat(c.commission_amount) : null,
          commission_type: c.commission_type || null,
          commission_rate: c.commission_rate !== null && c.commission_rate !== undefined ? parseFloat(c.commission_rate) : null,
          allow_advance_payment: !!c.allow_advance_payment,
          seller: {
            id_code: c.commission_seller_id || null,
            name: sellerName
          },
          source_transaction: c.sourceTransaction ? {
            id_code: c.sourceTransaction.id_code,
            status: c.sourceTransaction.status,
            is_deleted: !!c.sourceTransaction.is_deleted,
            amount: c.sourceTransaction.amount
          } : null,
          paid_transaction: c.paidTransaction ? {
            id_code: c.paidTransaction.id_code,
            status: c.paidTransaction.status,
            is_deleted: !!c.paidTransaction.is_deleted,
            amount: c.paidTransaction.amount
          } : null,
          issues
        });
      }

      const today = new Date();
      const y = today.getUTCFullYear();
      const m = String(today.getUTCMonth() + 1).padStart(2, '0');
      const d = String(today.getUTCDate()).padStart(2, '0');
      const todayStr = `${y}-${m}-${d}`;
      const future = new Date(today.getTime() + 7 * 86400000);
      const fy = future.getUTCFullYear();
      const fm = String(future.getUTCMonth() + 1).padStart(2, '0');
      const fd = String(future.getUTCDate()).padStart(2, '0');
      const futureStr = `${fy}-${fm}-${fd}`;
      const upcomingStatuses = ['pending', 'scheduled', 'approved', 'overdue', 'provisioned'];

      const [upRecv, upPay] = await Promise.all([
        FinancialTransaction.findAll({
          where: {
            ...txBaseWhere,
            type: 'RECEIVABLE',
            status: { [Op.in]: upcomingStatuses },
            due_date: { [Op.between]: [todayStr, futureStr] }
          },
          attributes: ['id_code', 'due_date', 'description', 'amount', 'party_id', 'category_id'],
          order: [['due_date', 'ASC']],
          limit: 10,
          raw: true
        }),
        FinancialTransaction.findAll({
          where: {
            ...txBaseWhere,
            type: 'PAYABLE',
            status: { [Op.in]: upcomingStatuses },
            due_date: { [Op.between]: [todayStr, futureStr] }
          },
          attributes: ['id_code', 'due_date', 'description', 'amount', 'party_id', 'category_id'],
          order: [['due_date', 'ASC']],
          limit: 10,
          raw: true
        })
      ]);

      const upcomingPartyIds = Array.from(new Set([
        ...upRecv.map(r => r.party_id).filter(Boolean),
        ...upPay.map(r => r.party_id).filter(Boolean)
      ]));
      const upcomingCategoryIds = Array.from(new Set([
        ...upRecv.map(r => r.category_id).filter(Boolean),
        ...upPay.map(r => r.category_id).filter(Boolean)
      ]));

      const [upcomingParties, upcomingCategories] = await Promise.all([
        upcomingPartyIds.length
          ? Party.findAll({ where: { id_code: { [Op.in]: upcomingPartyIds } }, attributes: ['id_code', 'name', 'trade_name'], raw: true })
          : [],
        upcomingCategoryIds.length
          ? FinCategory.findAll({ where: { id_code: { [Op.in]: upcomingCategoryIds } }, attributes: ['id_code', 'name'], raw: true })
          : []
      ]);

      for (const p of upcomingParties) partyNameById.set(p.id_code, p.trade_name || p.name);
      for (const c of upcomingCategories) categoryNameById.set(c.id_code, c.name);

      const costCenterTotalsRows = await FinancialTransaction.findAll({
        where: dateMode === 'cash' ? actualPaidWhere : plannedDueWhere,
        attributes: [
          'cost_center_id',
          'type',
          [fn('SUM', col('amount')), 'total']
        ],
        group: ['cost_center_id', 'type'],
        raw: true
      });

      const costCenterCategoryRows = await FinancialTransaction.findAll({
        where: dateMode === 'cash' ? actualPaidWhere : plannedDueWhere,
        attributes: [
          'cost_center_id',
          'category_id',
          'type',
          [fn('SUM', col('amount')), 'total']
        ],
        group: ['cost_center_id', 'category_id', 'type'],
        raw: true
      });

      const costCenterIds = Array.from(new Set(
        [...costCenterTotalsRows, ...costCenterCategoryRows].map(r => r.cost_center_id).filter(Boolean)
      ));
      const ccCategoryIds = Array.from(new Set(costCenterCategoryRows.map(r => r.category_id).filter(Boolean)));

      const [costCenters, ccCategories] = await Promise.all([
        costCenterIds.length
          ? FinCostCenter.findAll({ where: { id_code: { [Op.in]: costCenterIds } }, attributes: ['id_code', 'name', 'code'], raw: true })
          : [],
        ccCategoryIds.length
          ? FinCategory.findAll({ where: { id_code: { [Op.in]: ccCategoryIds } }, attributes: ['id_code', 'name'], raw: true })
          : []
      ]);

      const costCenterNameById = new Map(costCenters.map(c => [c.id_code, c.name]));
      for (const c of ccCategories) categoryNameById.set(c.id_code, c.name);

      const makeTotals = () => ({ received: 0, paid: 0, net: 0 });
      const costCentersMap = new Map();

      const getCostCenterEntry = (costCenterId) => {
        const key = costCenterId || '__none__';
        if (!costCentersMap.has(key)) {
          costCentersMap.set(key, {
            cost_center_id: costCenterId || null,
            cost_center_name: costCenterId ? (costCenterNameById.get(costCenterId) || costCenterId) : 'Sem centro de custo',
            totals: makeTotals(),
            categories: new Map()
          });
        }
        return costCentersMap.get(key);
      };

      const applyTotals = (totals, type, amount) => {
        if (type === 'RECEIVABLE') totals.received += amount;
        if (type === 'PAYABLE') totals.paid += amount;
        totals.net = totals.received - totals.paid;
      };

      for (const row of costCenterTotalsRows) {
        const amount = parseFloat(row.total || 0);
        const entry = getCostCenterEntry(row.cost_center_id);
        applyTotals(entry.totals, row.type, amount);
      }

      for (const row of costCenterCategoryRows) {
        const amount = parseFloat(row.total || 0);
        const entry = getCostCenterEntry(row.cost_center_id);
        const catKey = row.category_id || '__none__';
        if (!entry.categories.has(catKey)) {
          entry.categories.set(catKey, {
            category_id: row.category_id || null,
            category_name: row.category_id ? (categoryNameById.get(row.category_id) || row.category_id) : 'Sem categoria',
            totals: makeTotals()
          });
        }
        applyTotals(entry.categories.get(catKey).totals, row.type, amount);
      }

      const cost_centers = Array.from(costCentersMap.values())
        .map((cc) => ({
          cost_center_id: cc.cost_center_id,
          cost_center_name: cc.cost_center_name,
          totals: {
            received: parseFloat(cc.totals.received.toFixed(2)),
            paid: parseFloat(cc.totals.paid.toFixed(2)),
            net: parseFloat(cc.totals.net.toFixed(2))
          },
          categories: Array.from(cc.categories.values())
            .map((c) => ({
              category_id: c.category_id,
              category_name: c.category_name,
              totals: {
                received: parseFloat(c.totals.received.toFixed(2)),
                paid: parseFloat(c.totals.paid.toFixed(2)),
                net: parseFloat(c.totals.net.toFixed(2))
              }
            }))
            .sort((a, b) => (b.totals.paid + b.totals.received) - (a.totals.paid + a.totals.received))
        }))
        .sort((a, b) => (b.totals.paid + b.totals.received) - (a.totals.paid + a.totals.received));

      return res.json({
        success: true,
        scope: {
          store_ids: storeIds,
          start_date: startDate,
          end_date: endDate,
          date_mode: dateMode
        },
        compare_to_previous,
        kpis,
        timeseries: dates,
        top_expense_categories: topExpenseCategories,
        top_customers: topCustomers,
        cost_centers,
        commissions,
        commissions_pending_list,
        commission_inconsistencies,
        payment_methods,
        bank_accounts: bank_accounts_breakdown,
        tags,
        forecast_recurrences,
        upcoming: {
          receivable: upRecv.map(r => ({
            id_code: r.id_code,
            due_date: r.due_date,
            description: r.description,
            amount: parseFloat(r.amount),
            party_id: r.party_id || null,
            party_name: r.party_id ? (partyNameById.get(r.party_id) || r.party_id) : null,
            category_id: r.category_id || null,
            category_name: r.category_id ? (categoryNameById.get(r.category_id) || r.category_id) : null
          })),
          payable: upPay.map(r => ({
            id_code: r.id_code,
            due_date: r.due_date,
            description: r.description,
            amount: parseFloat(r.amount),
            party_id: r.party_id || null,
            party_name: r.party_id ? (partyNameById.get(r.party_id) || r.party_id) : null,
            category_id: r.category_id || null,
            category_name: r.category_id ? (categoryNameById.get(r.category_id) || r.category_id) : null
          }))
        }
      });
    } catch (error) {
      console.error('Analytics dashboard error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro ao montar dashboard' });
    }
  }
);

module.exports = router;
