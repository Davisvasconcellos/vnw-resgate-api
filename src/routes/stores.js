const express = require('express');
const { body, validationResult } = require('express-validator');
const { sequelize, Store, User, Product, StoreUser, StoreSchedule, StoreMember, Organization } = require('../models');
const { authenticateToken, requireRole, requireModule } = require('../middlewares/auth');
const { normalizeStoreSlug, isReservedStoreSlug } = require('../utils/storeSlug');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

/**
 * @swagger
 * /api/v1/stores:
 *   get:
 *     summary: Listar lojas
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de lojas
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 10, search } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (search) {
      where.name = { [require('sequelize').Op.like]: `%${search}%` };
    }

    // Se não for 'master', filtra as lojas para mostrar apenas as que o usuário é proprietário
    if (req.user.role !== 'master') {
      where.owner_id = req.user.userId;
    }

    // Calcula o total de lojas que o usuário pode ver
    let totalPlatformStores;
    if (req.user.role === 'master') {
      // Para master, conta todas as lojas da plataforma.
      totalPlatformStores = await Store.count();
    } else {
      // Para outros usuários, conta apenas as lojas que eles possuem.
      // O `where` já contém o filtro de owner_id.
      totalPlatformStores = await Store.count({ where });
    }

    const { count, rows: stores } = await Store.findAndCountAll({
      where,
      // Os campos novos já são retornados por padrão, pois não há `attributes` limitando a busca principal.
      include: [
        {
          model: User, as: 'owner', attributes: ['id_code', 'name', 'email']
        }, {
          model: User,
          as: 'users',
          attributes: ['id_code', 'name', 'role'],
          through: { attributes: ['role'] }
        },
        {
          model: StoreSchedule,
          as: 'schedules',
          attributes: { exclude: ['id', 'store_id', 'created_at', 'updated_at'] }
        }
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [
        ['created_at', 'DESC'],
        // Garante que os horários dentro de cada loja venham ordenados por dia da semana
        [{ model: StoreSchedule, as: 'schedules' }, 'day_of_week', 'ASC']
      ]
    });

    const responseData = {
      stores,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    };    responseData.totalPlatformStores = totalPlatformStores;

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    console.error('List stores error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

router.get('/check-slug', async (req, res) => {
  try {
    const rawSlug = req.query.slug;
    const normalized = normalizeStoreSlug(rawSlug);

    if (!normalized) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'slug é obrigatório'
      });
    }

    if (isReservedStoreSlug(normalized)) {
      return res.json({
        success: true,
        data: {
          slug: normalized,
          available: false,
          reason: 'reserved'
        }
      });
    }

    const existing = await Store.findOne({
      where: { slug: normalized },
      attributes: ['id_code', 'slug']
    });

    return res.json({
      success: true,
      data: {
        slug: normalized,
        available: !existing
      }
    });
  } catch (error) {
    console.error('Check store slug error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

router.get('/resolve', async (req, res) => {
  try {
    const raw = req.query.subdomain || req.query.slug;
    const slug = normalizeStoreSlug(raw);

    if (!slug) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'subdomain é obrigatório'
      });
    }

    const store = await Store.findOne({
      where: { slug, status: 'active' },
      attributes: ['id_code', 'name', 'slug', 'logo_url', 'banner_url', 'status', 'organization_id'],
      include: [
        {
          model: Organization,
          as: 'organization',
          attributes: ['id_code', 'name', 'logo_url', 'banner_url', 'status'],
          required: false
        }
      ]
    });

    if (!store) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Loja não encontrada'
      });
    }

    return res.json({
      success: true,
      data: {
        store: {
          id_code: store.id_code,
          name: store.name,
          slug: store.slug,
          status: store.status,
          logo_url: store.logo_url,
          banner_url: store.banner_url
        },
        organization: store.organization ? {
          id_code: store.organization.id_code,
          name: store.organization.name,
          status: store.organization.status,
          logo_url: store.organization.logo_url,
          banner_url: store.organization.banner_url
        } : null
      }
    });
  } catch (error) {
    console.error('Resolve store error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/stores/{id_code}:
 *   get:
 *     summary: Obter loja por ID Code
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dados da loja
 */
router.get('/:id_code', authenticateToken, async (req, res) => {
  try {
    const { id_code } = req.params;

    const store = await Store.findOne({
      where: { id_code },
      // Os campos novos já são retornados por padrão, pois não há `attributes` limitando a busca principal.
      include: [
        {
          model: User, as: 'owner', attributes: ['id_code', 'name', 'email']
        },
        {
          model: User,
          as: 'users',
          attributes: ['id_code', 'name', 'email', 'role'],
          through: { attributes: ['role'] }
        },
        {
          model: Product,
          as: 'products',
          attributes: ['id', 'name', 'normal_price', 'price_plan_1', 'price_plan_2', 'price_plan_3']
        }
      ]
    });

    if (!store) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Loja não encontrada'
      });
    }

    // Adiciona o include dos horários aqui também
    store.dataValues.schedules = await StoreSchedule.findAll({
      where: { store_id: store.id },
      order: [['day_of_week', 'ASC']],
      attributes: { exclude: ['id', 'store_id', 'created_at', 'updated_at'] }
    });

    res.json({
      success: true,
      data: store
    });

  } catch (error) {
    console.error('Get store error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * @swagger
 * /api/v1/stores:
 *   post:
 *     summary: Criar nova loja
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - legal_responsible
 *               - cnpj
 *               - description
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               cnpj:
 *                 type: string
 *               logo_url:
 *                 type: string
 *               instagram_handle:
 *                 type: string
 *               facebook_handle:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [bar, restaurante, pub, cervejaria, casa noturna, distribuidora]
 *               legal_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               address_street:
 *                 type: string
 *               address_neighborhood:
 *                 type: string
 *               address_state:
 *                 type: string
 *               address_number:
 *                 type: string
 *               address_complement:
 *                 type: string
 *               banner_url:
 *                 type: string
 *               website:
 *                 type: string
 *               latitude:
 *                 type: number
 *                 format: float
 *               longitude:
 *                 type: number
 *                 format: float
 *               zip_code:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Loja criada com sucesso
 */
router.post('/', 
  authenticateToken,
  requireModule('pub'),
  [
    // Validações existentes
    body('name').trim().isLength({ min: 2, max: 255 }).withMessage('Nome deve ter entre 2 e 255 caracteres'),
    body('email').isEmail().withMessage('Email inválido'),
    body('cnpj').isLength({ min: 14, max: 18 }).withMessage('CNPJ inválido'),
    body('logo_url').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do logo inválida'),
    body('instagram_handle').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Instagram deve ter no máximo 100 caracteres'),
    body('facebook_handle').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Facebook deve ter no máximo 100 caracteres'),
    // Novas validações
    body('capacity').optional().isInt({ min: 0 }).withMessage('Capacidade deve ser um número inteiro positivo'),
    body('type').optional().isString().trim(),
    body('legal_name').optional().isString().trim(),
    body('phone').optional().isString().trim(),
    body('address_street').optional().isString().trim(),
    body('address_neighborhood').optional().isString().trim(),
    body('address_city').optional().isString().trim(),
    body('address_state').optional().isString().trim().isLength({ min: 2, max: 2 }).withMessage('UF deve ter 2 caracteres'),
    body('address_number').optional().isString().trim(),
    body('address_complement').optional().isString().trim(),
    body('banner_url').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do banner inválida'),
    body('website').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do site inválida'),
    body('latitude').optional().isDecimal().withMessage('Latitude inválida'),
    body('longitude').optional().isDecimal().withMessage('Longitude inválida'),
    body('zip_code').optional().isString().trim(), // Movido para manter a ordem
    body('description').optional().isString().trim().escape().withMessage('Descrição inválida'),
    body('slug').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    const transaction = await sequelize.transaction();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Dados inválidos',
          details: errors.array()
        });
      }

      const {
        name,
        email,
        cnpj,
        logo_url,
        instagram_handle,
        facebook_handle,
        // Novos campos
        capacity,
        type,
        legal_name,
        phone,
        address_street,
        address_neighborhood,
        address_city,
        address_state,
        address_number,
        address_complement,
        banner_url,
        website,
        latitude,
        longitude,
        zip_code,
        description,
        slug: rawSlug
      } = req.body;

      let slug = rawSlug ? normalizeStoreSlug(rawSlug) : normalizeStoreSlug(name);
      if (!slug) {
        slug = `store-${uuidv4().slice(0, 8)}`;
      }
      if (isReservedStoreSlug(slug)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Slug inválido'
        });
      }
      if (slug.length < 3 || slug.length > 63) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Slug deve ter entre 3 e 63 caracteres'
        });
      }

      // Verificar se CNPJ já existe
      const existingStore = await Store.findOne({ where: { cnpj } });
      if (existingStore) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'CNPJ já utilizado'
        });
      }

      const existingSlug = await Store.findOne({ where: { slug } });
      if (existingSlug) {
        if (rawSlug) {
          return res.status(409).json({
            error: 'Conflict',
            message: 'Slug já utilizado'
          });
        }
        slug = `${slug}-${uuidv4().slice(0, 8)}`;
      }

      const store = await Store.create(
        {
          name,
          owner_id: req.user.userId, // Atribui o usuário logado como dono
          slug,
          email,
          cnpj,
          logo_url,
          instagram_handle,
          facebook_handle,
          // Novos campos
          capacity,
          type,
          legal_name,
          phone,
          zip_code,
          address_street,
          address_neighborhood,
          city: address_city, // Mapeia address_city para city
          address_state,
          address_number,
          address_complement,
          banner_url,
          website,
          latitude,
          longitude,
          description
        },
        { transaction }
      );

      // Criar os 7 dias de horário padrão (fechado)
      const schedules = [];
      for (let i = 0; i < 7; i++) {
        schedules.push({
          store_id: store.id,
          day_of_week: i,
          is_open: false
        });
      }
      await StoreSchedule.bulkCreate(schedules, { transaction });

      await transaction.commit();

      res.status(201).json({
        success: true,
        message: 'Loja criada com sucesso',
        data: store // O hook afterCreate do id_code ainda funcionará
      });

    } catch (error) {
      await transaction.rollback();
      console.error('Create store error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @swagger
 * /api/v1/stores/{id_code}:
 *   put:
 *     summary: Atualizar loja
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               cnpj:
 *                 type: string
 *               logo_url:
 *                 type: string
 *               instagram_handle:
 *                 type: string
 *               facebook_handle:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [bar, restaurante, pub, cervejaria, casa noturna, distribuidora]
 *               legal_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               address_street:
 *                 type: string
 *               address_neighborhood:
 *                 type: string
 *               address_state:
 *                 type: string
 *               address_number:
 *                 type: string
 *               address_complement:
 *                 type: string
 *               banner_url:
 *                 type: string
 *               website:
 *                 type: string
 *               latitude:
 *                 type: number
 *                 format: float
 *               longitude:
 *                 type: number
 *                 format: float
 *               zip_code:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Loja atualizada com sucesso
 */
router.put('/:id_code', authenticateToken, requireRole(['admin', 'manager']), [
    // Campos originais
    body('name').optional().trim().isLength({ min: 2, max: 255 }).withMessage('Nome deve ter entre 2 e 255 caracteres'),
    body('email').optional().isEmail().withMessage('Email inválido'),
    body('cnpj').optional().isLength({ min: 14, max: 18 }).withMessage('CNPJ inválido'),
    body('logo_url').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do logo inválida'),
    body('instagram_handle').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Instagram deve ter no máximo 100 caracteres'),
    body('facebook_handle').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Facebook deve ter no máximo 100 caracteres'),
    // Novos campos
    body('capacity').optional().isInt({ min: 0 }).withMessage('Capacidade deve ser um número inteiro positivo'),
    body('type').optional().isString().trim(),
    body('legal_name').optional().isString().trim(),
    body('phone').optional().isString().trim(),
    body('address_street').optional().isString().trim(),
    body('address_neighborhood').optional().isString().trim(),
    body('address_city').optional().isString().trim(),
    body('address_state').optional().isString().trim().isLength({ min: 2, max: 2 }).withMessage('UF deve ter 2 caracteres'),
    body('address_number').optional().isString().trim(),
    body('address_complement').optional().isString().trim(),
    body('banner_url').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do banner inválida'),
    body('website').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do site inválida'),
    body('latitude').optional().isDecimal().withMessage('Latitude inválida'),
    body('longitude').optional().isDecimal().withMessage('Longitude inválida'),
    body('zip_code').optional().isString().trim(), // Movido para manter a ordem
    body('description').optional().isString().trim().escape().withMessage('Descrição inválida'),
    body('slug').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    try {
      const { id_code } = req.params;
      const errors = validationResult(req);
      
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Dados inválidos',
          details: errors.array()
        });
      }

      const store = await Store.findOne({ where: { id_code } });
      if (!store) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Loja não encontrada'
        });
      }

      // Verificar permissão
      // O proprietário da loja (owner) ou um 'master' podem editar.
      // Um 'manager' associado à loja também pode editar.
      const isOwner = store.owner_id === req.user.userId;
      const isMaster = req.user.role === 'master';

      if (!isOwner && !isMaster && req.user.role !== 'admin') {
        const storeUser = await StoreUser.findOne({
          where: { user_id: req.user.id, store_id: store.id }
        });
        if (!storeUser) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'Sem permissão para editar esta loja'
          });
        }
      }

      // Regra especial para atualização de CNPJ
      const isCnpjUpdateAttempt = req.body.cnpj && req.body.cnpj !== store.cnpj;

      if (isCnpjUpdateAttempt) {
        // Se a loja não tem CNPJ (primeira vez), permite atualizar.
        // Se a loja JÁ TEM CNPJ, apenas 'master' pode alterar.
        const storeHasCnpj = store.cnpj && store.cnpj.trim() !== '';

        if (storeHasCnpj && req.user.role !== 'master') {
            // Ignora a tentativa de atualização (mantém o CNPJ antigo) sem lançar erro
            delete req.body.cnpj;
        } else {
            // Se for permitido (master ou primeira vez), verifica duplicidade
            const existingStore = await Store.findOne({ where: { cnpj: req.body.cnpj } });
            // Se achar outra loja com esse CNPJ (e não for a mesma loja), erro
            if (existingStore && existingStore.id !== store.id) {
                return res.status(400).json({ error: 'Validation error', message: 'CNPJ já utilizado por outra loja.' });
            }
        }
      } else {
        // Se não for uma tentativa de update (mesmo valor ou vazio), remove para evitar re-processamento desnecessário
        delete req.body.cnpj; 
      }

      // Se não for master, remove o campo CNPJ do corpo da requisição para garantir que ele não seja atualizado.
      // (Isso já foi tratado acima, mas mantemos a segurança extra caso a lógica acima falhe ou seja alterada)
      // Mas espere, se for a primeira vez, precisamos PERMITIR que req.body.cnpj passe.
      // Então a lógica acima já deletou se não podia. Aqui não devemos deletar incondicionalmente.
      
      // Código antigo removido:
      /*
      if (req.user.role !== 'master') {
        delete req.body.cnpj;
      }
      */

      // Mapear address_city para city
      if (req.body.address_city) {
        req.body.city = req.body.address_city;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'slug')) {
        const nextSlug = normalizeStoreSlug(req.body.slug);
        if (!nextSlug) {
          return res.status(400).json({ error: 'Validation error', message: 'Slug inválido' });
        }
        if (isReservedStoreSlug(nextSlug)) {
          return res.status(400).json({ error: 'Validation error', message: 'Slug inválido' });
        }
        if (nextSlug.length < 3 || nextSlug.length > 63) {
          return res.status(400).json({ error: 'Validation error', message: 'Slug deve ter entre 3 e 63 caracteres' });
        }
        const existingSlug = await Store.findOne({ where: { slug: nextSlug } });
        if (existingSlug && existingSlug.id !== store.id) {
          return res.status(409).json({ error: 'Conflict', message: 'Slug já utilizado' });
        }
        req.body.slug = nextSlug;
      }

      await store.update(req.body);

      res.json({
        success: true,
        message: 'Loja atualizada com sucesso',
        data: store
      });

    } catch (error) {
      console.error('Update store error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Erro interno do servidor'
      });
    }
  }
);

router.patch('/:id_code/members/:member_id_code', authenticateToken, async (req, res) => {
  try {
    const { id_code, member_id_code } = req.params;
    const { role } = req.body;

    const store = await Store.findOne({ where: { id_code } });
    if (!store) {
      return res.status(404).json({ error: 'Not Found', message: 'Loja não encontrada' });
    }

    const highPrivilegeRoles = ['admin', 'master', 'masteradmin'];
    const isOwner = store.owner_id && String(store.owner_id) === String(req.user.userId);
    const isHighPrivilege = highPrivilegeRoles.includes(req.user.role);

    if (!isHighPrivilege && !isOwner) {
      const requesterMember = await StoreMember.findOne({
        where: { store_id: store.id, user_id: req.user.userId, status: 'active' }
      });

      if (!requesterMember || requesterMember.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para gerenciar membros desta loja' });
      }
    }

    const member = await StoreMember.findOne({
      where: { id_code: member_id_code, store_id: store.id }
    });

    if (!member) {
      return res.status(404).json({ error: 'Not Found', message: 'Membro não encontrado' });
    }

    if (store.owner_id && String(member.user_id) === String(store.owner_id)) {
      return res.status(400).json({ error: 'Validation error', message: 'Não é possível alterar o cargo do proprietário da loja' });
    }

    if (role && ['manager', 'collaborator', 'viewer'].includes(role)) {
      await member.update({ role });
      
      // Também seria útil atualizar o StoreUser legado se existir
      const { StoreUser } = require('../models');
      const storeUser = await StoreUser.findOne({ where: { user_id: member.user_id, store_id: store.id } });
      if (storeUser) {
        await storeUser.update({ role });
      }
    }

    return res.json({ success: true, message: 'Membro atualizado com sucesso', data: member });
  } catch (error) {
    console.error('Update store member error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.delete('/:id_code/members/:member_id_code', authenticateToken, async (req, res) => {
  try {
    const { id_code, member_id_code } = req.params;

    const store = await Store.findOne({ where: { id_code } });
    if (!store) {
      return res.status(404).json({ error: 'Not Found', message: 'Loja não encontrada' });
    }

    const highPrivilegeRoles = ['admin', 'master', 'masteradmin'];
    const isOwner = store.owner_id && String(store.owner_id) === String(req.user.userId);
    const isHighPrivilege = highPrivilegeRoles.includes(req.user.role);

    if (!isHighPrivilege && !isOwner) {
      const requesterMember = await StoreMember.findOne({
        where: { store_id: store.id, user_id: req.user.userId, status: 'active' }
      });

      if (!requesterMember || requesterMember.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para gerenciar membros desta loja' });
      }
    }

    const member = await StoreMember.findOne({
      where: { id_code: member_id_code, store_id: store.id }
    });

    if (!member) {
      return res.status(404).json({ error: 'Not Found', message: 'Membro não encontrado' });
    }

    if (store.owner_id && String(member.user_id) === String(store.owner_id)) {
      return res.status(400).json({ error: 'Validation error', message: 'Não é possível remover o proprietário da loja' });
    }

    await member.update({ status: 'inactive' });

    return res.json({ success: true, message: 'Membro removido com sucesso' });
  } catch (error) {
    console.error('Remove store member error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

/**
 * @swagger
 * /api/v1/stores/{id_code}:
 *   delete:
 *     summary: Deletar loja
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Loja deletada com sucesso
 */
router.delete('/:id_code',
  authenticateToken,
  requireRole(['admin']),
  async (req, res) => {
    try {
      const { id_code } = req.params;

      const store = await Store.findOne({ where: { id_code } });
      if (!store) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Loja não encontrada'
        });
      }

      // Verificar se há produtos associados
      const productCount = await Product.count({ where: { store_id: store.id } });
      if (productCount > 0) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Não é possível deletar uma loja que possui produtos'
        });
      }

      await store.destroy();

      res.json({
        success: true,
        message: 'Loja deletada com sucesso'
      });

    } catch (error) {
      console.error('Delete store error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Erro interno do servidor'
      });
    }
  }
);

/**
 * @swagger
 * /api/v1/stores/{id_code}/schedule:
 *   put:
 *     summary: Atualizar os horários de funcionamento de uma loja
 *     tags: [Stores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id_code
 *         required: true
 *         schema:
 *           type: string
 *         description: O ID Code da loja
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: array
 *             items:
 *               type: object
 *               properties:
 *                 day_of_week:
 *                   type: integer
 *                   example: 1
 *                 is_open:
 *                   type: boolean
 *                   example: true
 *                 opening_time:
 *                   type: string
 *                   example: "09:00"
 *                 closing_time:
 *                   type: string
 *                   example: "22:00"
 *     responses:
 *       200:
 *         description: Horários atualizados com sucesso
 */
router.put('/:id_code/schedule',
  authenticateToken,
  requireRole(['admin', 'manager']),
  [
    body().isArray({ min: 1, max: 7 }).withMessage('O corpo da requisição deve ser um array com 1 a 7 dias.'),
    body('*.day_of_week').isInt({ min: 0, max: 6 }).withMessage('day_of_week deve ser um número entre 0 e 6.'),
    body('*.is_open').isBoolean().withMessage('is_open deve ser um valor booleano.'),
    body('*.opening_time').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional({ nullable: true }).withMessage('opening_time deve estar no formato HH:MM.'),
    body('*.closing_time').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/).optional({ nullable: true }).withMessage('closing_time deve estar no formato HH:MM.')
  ],
  async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
      const { id_code } = req.params;
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation error', details: errors.array() });
      }

      const store = await Store.findOne({ where: { id_code } });
      if (!store) {
        return res.status(404).json({ error: 'Not Found', message: 'Loja não encontrada' });
      }

      // Verificar permissão (proprietário, master, admin ou manager da loja)
      const isOwner = store.owner_id === req.user.userId;
      const isMaster = req.user.role === 'master';
      if (!isOwner && !isMaster && req.user.role !== 'admin') {
        const storeUser = await StoreUser.findOne({ where: { user_id: req.user.userId, store_id: store.id } });
        if (!storeUser) {
          return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para editar os horários desta loja' });
        }
      }

      const schedules = req.body;

      for (const schedule of schedules) {
        await StoreSchedule.update(
          {
            is_open: schedule.is_open,
            opening_time: schedule.is_open ? schedule.opening_time : null,
            closing_time: schedule.is_open ? schedule.closing_time : null,
          },
          {
            where: { store_id: store.id, day_of_week: schedule.day_of_week },
            transaction
          }
        );
      }

      await transaction.commit();

      // Após o commit, busca e retorna todos os horários atualizados da loja
      const updatedSchedules = await StoreSchedule.findAll({
        where: { store_id: store.id },
        order: [['day_of_week', 'ASC']],
        attributes: { exclude: ['id', 'store_id', 'created_at', 'updated_at'] }
      });

      res.json({
        success: true,
        message: 'Horários de funcionamento atualizados com sucesso.',
        data: updatedSchedules
      });
      
    } catch (error) {
      await transaction.rollback();
      console.error('Update schedule error:', error);
      res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

/**
 * @swagger
 * /api/v1/stores/{storeId}/vendors:
 *   get:
 *     summary: Listar fornecedores da loja
 *     tags: [Accounts Payable]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de fornecedores
 */

/**
 * @swagger
 * /api/v1/stores/{storeId}/vendors:
 *   post:
 *     summary: Criar fornecedor
 *     tags: [Accounts Payable]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               document: { type: string }
 *               email: { type: string, format: email }
 *               phone: { type: string }
 *               bank_info: { type: object }
 *     responses:
 *       201:
 *         description: Fornecedor criado
 */

/**
 * @swagger
 * /api/v1/stores/{storeId}/payables:
 *   get:
 *     summary: Listar contas a pagar
 *     tags: [Accounts Payable]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, scheduled, paid, overdue, canceled] }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [asc, desc] }
 *     responses:
 *       200:
 *         description: Lista de títulos
 */

/**
 * @swagger
 * /api/v1/stores/{storeId}/payables:
 *   post:
 *     summary: Criar título a pagar
 *     tags: [Accounts Payable]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vendor_id, amount, due_date]
 *             properties:
 *               vendor_id: { type: integer }
 *               amount: { type: number }
 *               currency: { type: string, default: BRL }
 *               issue_date: { type: string, format: date }
 *               due_date: { type: string, format: date }
 *               invoice_number: { type: string }
 *               description: { type: string }
 *               category: { type: string }
 *               cost_center: { type: string }
 *               attachment_url: { type: string, format: uri }
 *     responses:
 *       201:
 *         description: Título criado
 */

/**
 * @swagger
 * /api/v1/stores/{storeId}/payables/{id}/status:
 *   patch:
 *     summary: Atualizar status do título
 *     tags: [Accounts Payable]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [pending, approved, scheduled, paid, overdue, canceled] }
 *               paid_at: { type: string, format: date-time }
 *               conciliated_by: { type: string, enum: [system, manual, gpt] }
 *               conciliated_at: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Título atualizado
 */

/**
 * @swagger
 * /api/v1/stores/{storeId}/payables/{id}/payments:
 *   post:
 *     summary: Registrar pagamento do título
 *     tags: [Accounts Payable]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount, paid_at, method]
 *             properties:
 *               amount: { type: number }
 *               paid_at: { type: string, format: date-time }
 *               method: { type: string, enum: [pix, bank_transfer, cash, card] }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Pagamento registrado
 */

module.exports = router; 
