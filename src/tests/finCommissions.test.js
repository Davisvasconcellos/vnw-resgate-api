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
  FinancialCommission: {
    findAll: jest.fn().mockResolvedValue([
      { toJSON: () => ({ status: 'pending', count: '2', total_amount: '150.50' }) },
      { toJSON: () => ({ status: 'paid', count: '1', total_amount: '99.99' }) }
    ]),
    findAndCountAll: jest.fn().mockResolvedValue({
      count: 1,
      rows: [{ id_code: 'com-1', toJSON() { return { id_code: 'com-1', store_id: 'store-uuid-1' }; } }]
    })
  },
  Party: {},
  FinancialTransaction: {}
}));

const routes = require('../routes/finCommissions');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/financial/commissions', routes);
  return app;
}

describe('Financial commissions', () => {
  it('lists commissions', async () => {
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
  });
});
