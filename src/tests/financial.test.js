
const request = require('supertest');
const { sequelize } = require('../models');

// MOCK MIDDLEWARE BEFORE IMPORTING APP
jest.mock('../middlewares/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: 1, role: 'admin' };
    next();
  },
  requireRole: (...roles) => (req, res, next) => {
    next();
  },
  requireModule: (moduleSlug) => (req, res, next) => {
    next();
  }
}));

jest.mock('../middlewares/storeContext', () => ({
  requireStoreContext: () => (req, res, next) => {
    req.storeId = String(req.query.store_id || req.body.store_id || 'store-uuid-1');
    next();
  },
  requireStoreAccess: (req, res, next) => {
    req.storeDbId = 10;
    req.store = { id: 10, id_code: req.storeId, name: 'Loja Teste', owner_id: 1 };
    next();
  }
}));

jest.mock('../middlewares/storePermissions', () => ({
  requireStorePermission: () => (req, res, next) => next()
}));

// MOCK MODELS
jest.mock('../models', () => {
  const Sequelize = require('sequelize');
  return {
    sequelize: {
      define: jest.fn(),
      authenticate: jest.fn(),
      close: jest.fn(),
      transaction: jest.fn(() => Promise.resolve({ commit: jest.fn(), rollback: jest.fn() }))
    },
    User: {
      findByPk: jest.fn().mockResolvedValue({ 
        id: 1, 
        id_code: 'user-uuid-1',
        name: 'Admin User' 
      })
    },
    FinancialTransaction: {
      create: jest.fn().mockImplementation((payload) => {
        const instance = {
          ...payload,
          id_code: 'txn-uuid-123',
          created_at: new Date(),
          updated_at: new Date(),
          attachment_url: null,
          setTags: jest.fn().mockResolvedValue(true),
          reload: jest.fn().mockResolvedValue(true),
          toJSON: function() { return this; }
        };
        return Promise.resolve(instance);
      }),
      findAndCountAll: jest.fn().mockResolvedValue({
        count: 1,
        rows: [{
          id_code: 'txn-uuid-123',
          type: 'PAYABLE',
          description: 'Teste',
          amount: 100,
          due_date: '2026-02-10',
          store_id: 'store-1',
          status: 'pending'
        }]
      })
    },
    FinancialCommission: {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((payload) => Promise.resolve({
        ...payload,
        id_code: 'com-uuid-1',
        toJSON: function() { return this; }
      }))
    },
    Party: {
      findOne: jest.fn()
    },
    Op: Sequelize.Op
  };
});

const app = require('../server');

describe('Financial Transactions API', () => {
  describe('POST /api/v1/financial/transactions', () => {
    it('should create a transaction with store_id and approved_by', async () => {
      const payload = {
        type: 'PAYABLE',
        description: 'Compra de Insumos',
        amount: 1500.00,
        due_date: '2026-02-10',
        is_paid: false,
        status: 'pending',
        store_id: 'store-uuid-999',
        approved_by: 'manager-uuid-888'
      };

      const res = await request(app)
        .post('/api/v1/financial/transactions')
        .send(payload);

      expect(res.statusCode).toEqual(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.store_id).toEqual('store-uuid-999');
    });

    it('should create a commission when salesperson fields are provided', async () => {
      const { Party, FinancialCommission } = require('../models');
      Party.findOne.mockResolvedValue({ id_code: 'pty-vendor-1', is_salesperson: true });
      FinancialCommission.findOne.mockResolvedValue(null);

      const payload = {
        type: 'RECEIVABLE',
        description: 'Venda',
        amount: 10000,
        due_date: '2026-02-10',
        is_paid: false,
        status: 'pending',
        store_id: 'store-uuid-999',
        commission_seller_id: 'pty-vendor-1',
        commission_type: 'percentage',
        commission_rate: 10,
        commission_amount: 1000
      };

      const res = await request(app)
        .post('/api/v1/financial/transactions')
        .send(payload);

      expect(res.statusCode).toEqual(201);
      expect(FinancialCommission.create).toHaveBeenCalled();
      expect(res.body.data.commission.commission_seller_id).toBe('pty-vendor-1');
      expect(res.body.data.commission.commission_amount).toBe(1000);
    });
  });

  describe('GET /api/v1/financial/transactions', () => {
    it('should list transactions with pagination', async () => {
      // Mock findAll for KPI summary
      const { FinancialTransaction } = require('../models');
      FinancialTransaction.findAll = jest.fn().mockResolvedValue([
        { type: 'PAYABLE', status: 'pending', total_amount: 500 }
      ]);

      const res = await request(app)
        .get('/api/v1/financial/transactions')
        .query({ page: 1, limit: 10, store_id: 'store-1', kpi_linked: 'true' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta.total).toBe(1);
      // Data is now an object with transactions and summary
      expect(res.body.data.transactions[0].id_code).toBe('txn-uuid-123');
      expect(res.body.data.summary.payable.pending).toBe(500);
    });
  });

  describe('PATCH /api/v1/financial/transactions/:id_code', () => {
    it('should update a transaction', async () => {
      // Mock findOne to return a transaction
      const mockTransaction = {
        id_code: 'txn-uuid-123',
        amount: 100,
        status: 'pending',
        is_paid: false,
        due_date: '2026-02-20',
        toJSON: function() { return this; },
        update: jest.fn().mockResolvedValue(true),
        reload: jest.fn().mockResolvedValue(true),
        created_at: new Date(),
        created_by_user_id: 1
      };
      
      const { FinancialTransaction } = require('../models');
      FinancialTransaction.findOne = jest.fn().mockResolvedValue(mockTransaction);

      const res = await request(app)
        .patch('/api/v1/financial/transactions/txn-uuid-123')
        .send({ amount: 200 });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
    });

    it('should not allow updating a paid transaction (non-cancel change)', async () => {
      const paidTransaction = {
        id_code: 'txn-paid-1',
        amount: 100,
        status: 'paid',
        is_paid: true,
        due_date: '2026-02-20',
        toJSON: function() { return this; },
        update: jest.fn(),
        reload: jest.fn(),
        created_at: new Date(),
        created_by_user_id: 1
      };

      const { FinancialTransaction } = require('../models');
      FinancialTransaction.findOne = jest.fn().mockResolvedValue(paidTransaction);

      const res = await request(app)
        .patch('/api/v1/financial/transactions/txn-paid-1')
        .send({ amount: 200 });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Validation error');
    });


    it('should not allow updating a canceled transaction', async () => {
      const canceledTransaction = {
        id_code: 'txn-canceled-1',
        amount: 100,
        status: 'canceled',
        is_paid: false,
        due_date: '2026-02-20',
        toJSON: function() { return this; },
        update: jest.fn(),
        reload: jest.fn(),
        created_at: new Date(),
        created_by_user_id: 1
      };

      const { FinancialTransaction } = require('../models');
      FinancialTransaction.findOne = jest.fn().mockResolvedValue(canceledTransaction);

      const res = await request(app)
        .patch('/api/v1/financial/transactions/txn-canceled-1')
        .send({ amount: 200 });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Validation error');
    });
  });
});
