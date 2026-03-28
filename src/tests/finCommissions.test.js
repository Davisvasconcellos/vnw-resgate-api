const express = require('express');
const request = require('supertest');

jest.mock('../middlewares/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: 1, role: 'admin' };
    next();
  },
  requireModule: () => (req, res, next) => next()
}));

jest.mock('../middlewares/storeContext', () => ({
  requireStoreContext: () => (req, res, next) => {
    req.storeId = String(req.query.store_id || req.body.store_id || 'store-uuid-1');
    next();
  },
  requireStoreAccess: (req, res, next) => next()
}));

jest.mock('../middlewares/storePermissions', () => ({
  requireStorePermission: () => (req, res, next) => next()
}));

jest.mock('../models', () => ({
  sequelize: {
    transaction: jest.fn(async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }))
  },
  FinancialCommission: {
    findAll: jest.fn(),
    findAndCountAll: jest.fn()
  },
  Party: {},
  FinancialTransaction: {
    create: jest.fn().mockResolvedValue({ id_code: 'txn-pay-1' })
  }
}));

const routes = require('../routes/finCommissions');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/financial/commissions', routes);
  return app;
}

describe('Financial commissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists commissions', async () => {
    const { FinancialCommission } = require('../models');
    FinancialCommission.findAll.mockResolvedValue([
      { toJSON: () => ({ status: 'pending', count: '2', total_amount: '150.50' }) },
      { toJSON: () => ({ status: 'paid', count: '1', total_amount: '99.99' }) }
    ]);
    FinancialCommission.findAndCountAll.mockResolvedValue({
      count: 1,
      rows: [{
        id_code: 'com-1',
        toJSON() {
          return {
            id_code: 'com-1',
            store_id: 'store-uuid-1',
            allow_advance_payment: false,
            sourceTransaction: { status: 'pending' }
          };
        }
      }]
    });

    const app = makeApp();
    const res = await request(app)
      .get('/api/v1/financial/commissions')
      .query({ store_id: 'store-uuid-1' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary.pending.count).toBe(2);
    expect(res.body.summary.pending.amount).toBe(150.5);
    expect(res.body.summary.paid.count).toBe(1);
    expect(res.body.summary.paid.amount).toBe(99.99);
    expect(res.body.data[0].id).toBe('com-1');
    expect(res.body.data[0].payable).toBe(false);
  });

  it('pays commissions in batch', async () => {
    const { FinancialCommission, FinancialTransaction } = require('../models');
    FinancialCommission.findAll.mockResolvedValue([
      {
        id_code: 'com-1',
        status: 'pending',
        paid_transaction_id_code: null,
        commission_amount: '22.50',
        commission_seller_id: 'pty-1',
        allow_advance_payment: false,
        commission_type: 'percentage',
        commission_rate: '15',
        source_transaction_id_code: 'txn-1',
        commissionSeller: { trade_name: 'Vendedor ABC' },
        sourceTransaction: { id_code: 'txn-1', nf: 'NOTA001', amount: '150.00', description: 'Venda X', status: 'paid' },
        update: jest.fn().mockResolvedValue(true)
      },
      {
        id_code: 'com-2',
        status: 'paid',
        paid_transaction_id_code: 'txn-old',
        commission_amount: '10.00',
        commission_seller_id: 'pty-1',
        source_transaction_id_code: 'txn-2',
        update: jest.fn().mockResolvedValue(true)
      }
    ]);

    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/financial/commissions/pay')
      .query({ store_id: 'store-uuid-1' })
      .send({ commission_ids: ['com-1', 'com-2', 'com-404'], bank_account_id: 'bk-1', paid_at: '2026-03-28' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paid_count).toBe(1);
    expect(res.body.data.skipped_count).toBe(1);
    expect(res.body.data.not_found_count).toBe(1);
    expect(FinancialTransaction.create).toHaveBeenCalled();
    const createPayload = FinancialTransaction.create.mock.calls[0][0];
    expect(createPayload.description).toContain('Comissão - Vendedor ABC');
    expect(createPayload.description).toContain('NF NOTA001');
    expect(createPayload.description).toContain('Base 150.00');
    expect(createPayload.description).toContain('Taxa 15%');
    expect(createPayload.description).toContain('Comissão 22.50');
  });

  it('does not pay commission when source is not paid and advance is not allowed', async () => {
    const { FinancialCommission, FinancialTransaction } = require('../models');
    FinancialCommission.findAll.mockResolvedValue([
      {
        id_code: 'com-1',
        status: 'pending',
        paid_transaction_id_code: null,
        commission_amount: '22.50',
        commission_seller_id: 'pty-1',
        allow_advance_payment: false,
        commission_type: 'percentage',
        commission_rate: '15',
        source_transaction_id_code: 'txn-1',
        commissionSeller: { trade_name: 'Vendedor ABC' },
        sourceTransaction: { id_code: 'txn-1', nf: 'NOTA001', amount: '150.00', description: 'Venda X', status: 'pending' },
        update: jest.fn().mockResolvedValue(true)
      }
    ]);

    const app = makeApp();
    const res = await request(app)
      .post('/api/v1/financial/commissions/pay')
      .query({ store_id: 'store-uuid-1' })
      .send({ commission_ids: ['com-1'], bank_account_id: 'bk-1', paid_at: '2026-03-28' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.paid_count).toBe(0);
    expect(res.body.data.skipped_count).toBe(1);
    expect(res.body.data.skipped[0].reason).toBe('not_payable');
    expect(FinancialTransaction.create).not.toHaveBeenCalled();
  });
});
