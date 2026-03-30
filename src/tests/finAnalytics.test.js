const express = require('express');
const request = require('supertest');

jest.mock('../middlewares/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: 1, role: 'admin' };
    next();
  },
  requireModule: () => (req, res, next) => next()
}));

jest.mock('../models', () => ({
  FinancialTransaction: {
    findAll: jest.fn().mockResolvedValue([])
  },
  FinancialCommission: {
    findAll: jest.fn().mockResolvedValue([])
  },
  Party: {
    findAll: jest.fn().mockResolvedValue([])
  },
  FinCategory: {
    findAll: jest.fn().mockResolvedValue([])
  },
  FinCostCenter: {
    findAll: jest.fn().mockResolvedValue([])
  },
  FinTag: {
    findAll: jest.fn().mockResolvedValue([])
  },
  FinRecurrence: {
    findAll: jest.fn().mockResolvedValue([])
  },
  BankAccount: {
    findAll: jest.fn().mockResolvedValue([])
  },
  Store: {
    findAll: jest.fn().mockResolvedValue([])
  },
  StoreMember: {
    findAll: jest.fn().mockResolvedValue([])
  },
  StoreUser: {
    findAll: jest.fn().mockResolvedValue([])
  },
  sequelize: {
    query: jest.fn()
      .mockResolvedValueOnce([[{ total_count: 0, total_amount: '0' }]])
      .mockResolvedValueOnce([[{ tagged_count: 0 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ total_amount: '0' }]])
  }
}));

const routes = require('../routes/finAnalytics');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/financial/analytics', routes);
  return app;
}

describe('Financial analytics dashboard', () => {
  it('returns dashboard shape', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/v1/financial/analytics/dashboard')
      .query({ start_date: '2026-03-01', end_date: '2026-03-31' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.kpis).toBeDefined();
    expect(Array.isArray(res.body.timeseries)).toBe(true);
    expect(Array.isArray(res.body.top_expense_categories)).toBe(true);
    expect(Array.isArray(res.body.top_customers)).toBe(true);
    expect(Array.isArray(res.body.cost_centers)).toBe(true);
    expect(res.body.commissions).toBeDefined();
    expect(res.body.commission_inconsistencies).toBeDefined();
    expect(Array.isArray(res.body.commission_inconsistencies.items)).toBe(true);
    expect(res.body.compare_to_previous).toBeDefined();
    expect(res.body.payment_methods).toBeDefined();
    expect(Array.isArray(res.body.bank_accounts)).toBe(true);
    expect(res.body.tags).toBeDefined();
    expect(res.body.forecast_recurrences).toBeDefined();
    expect(res.body.commissions_pending_list).toBeDefined();
    expect(Array.isArray(res.body.commissions_pending_list.items)).toBe(true);
    expect(res.body.upcoming).toBeDefined();
  });
});
