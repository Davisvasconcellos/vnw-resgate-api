const express = require('express');
const router = express.Router();
const { Organization, Store, StoreMember, User, StoreSchedule, sequelize } = require('../models');
const { authenticateToken } = require('../middlewares/auth');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { normalizeStoreSlug, isReservedStoreSlug } = require('../utils/storeSlug');

// GET /api/v1/organizations/me
// Returns organizations owned by user AND stores where user is a member
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 1. Organizations I own
    const ownedOrgs = await Organization.findAll({
      where: { owner_id: userId, status: 'active' },
      include: [
        {
          model: Store,
          as: 'stores',
          attributes: ['id', 'id_code', 'name', 'slug', 'logo_url', 'banner_url', 'status']
        }
      ]
    });

    // 2. Stores I am a member of (excluding ones I own via organization, to avoid duplicates if we auto-add owner as member)
    // Actually, good practice: Owner should ALSO be a StoreMember to unify permission logic.
    // So we just query StoreMember.

    const memberships = await StoreMember.findAll({
      where: { user_id: userId, status: 'active' },
      include: [
        {
          model: Store,
          as: 'store',
          include: [{ model: Organization, as: 'organization', attributes: ['id', 'id_code', 'name', 'logo_url', 'banner_url'] }]
        }
      ]
    });

    // Transform for frontend
    const result = {
      owned_organizations: ownedOrgs.map(o => ({
        id: o.id_code,
        name: o.name,
        plan: o.plan_tier,
        logo_url: o.logo_url,
        banner_url: o.banner_url,
        stores: o.stores.map(s => ({ id: s.id_code, name: s.name, slug: s.slug, logo_url: s.logo_url, banner_url: s.banner_url }))
      })),
      memberships: memberships.map(m => ({
        store_id: m.store.id_code,
        store_name: m.store.name,
        organization_name: m.store.organization.name,
        role: m.role,
        permissions: m.permissions
      }))
    };

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error fetching user context:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/organizations/:id_code/stores
// List stores of a specific organization (restricted access)
router.get('/:id_code/stores', authenticateToken, async (req, res) => {
  const { id_code } = req.params;
  const userId = req.user.userId;

  try {
    const org = await Organization.findOne({ where: { id_code } });
    if (!org) return res.status(404).json({ error: 'Not Found', message: 'Organização não encontrada' });

    const isOwner = org.owner_id === userId;

    // If not owner, check membership in any store of this org
    let allowedStoreIds = [];
    if (!isOwner) {
      const memberships = await StoreMember.findAll({
        where: { user_id: userId, status: 'active' },
        include: [{
          model: Store,
          as: 'store',
          where: { organization_id: org.id },
          attributes: ['id']
        }]
      });

      if (memberships.length === 0) {
        return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para visualizar lojas desta organização' });
      }
      allowedStoreIds = memberships.map(m => m.store.id);
    }

    // Build query
    const whereClause = { organization_id: org.id, status: 'active' };
    if (!isOwner) {
      whereClause.id = allowedStoreIds;
    }

    const stores = await Store.findAll({
      where: whereClause,
      attributes: ['id_code', 'name', 'slug', 'city', 'address', 'logo_url', 'banner_url', 'status'] // Add other relevant fields
    });

    res.json({ success: true, data: stores });
  } catch (err) {
    console.error('Error fetching organization stores:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/organizations/:id_code/stores
// Create a new store within an organization
router.post('/:id_code/stores', authenticateToken, [
  body('name').trim().isLength({ min: 2, max: 255 }).withMessage('Nome deve ter entre 2 e 255 caracteres'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Email inválido'),
  body('cnpj').optional({ checkFalsy: true }).isLength({ min: 14, max: 18 }).withMessage('CNPJ inválido'),
  body('logo_url').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do logo inválida'),
  body('banner_url').optional({ checkFalsy: true }).isURL({ require_tld: false }).withMessage('URL do banner inválida'),
  body('type').optional().isString().trim(),
  body('address_city').optional().isString().trim(),
  body('address_state').optional().isString().trim().isLength({ min: 2, max: 2 }).withMessage('UF deve ter 2 caracteres'),
  body('slug').optional({ nullable: true }).isString(),
  // Other fields can be optional or use defaults
], async (req, res) => {
  const { id_code } = req.params;
  const userId = req.user.userId;

  // Transaction for atomicity
  const t = await require('../config/database').sequelize.transaction();

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await t.rollback();
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    // 1. Find Organization and verify ownership/permission
    const org = await Organization.findOne({ where: { id_code } });
    if (!org) {
      await t.rollback();
      return res.status(404).json({ error: 'Not Found', message: 'Organização não encontrada' });
    }

    // Permission check: Owner of the organization OR System Admin
    const isOwner = String(org.owner_id) === String(userId);
    const isAdmin = req.user.role === 'admin';

    if (!isOwner && !isAdmin) {
      await t.rollback();
      return res.status(403).json({ error: 'Forbidden', message: 'Apenas o proprietário da organização pode criar novas lojas.' });
    }

    // 2. Validate Plan Limits (Optional/Future)
    // const storeCount = await Store.count({ where: { organization_id: org.id } });
    // if (org.plan_tier === 'free' && storeCount >= 1) ...

    const {
      name, email, cnpj, logo_url, banner_url,
      type, legal_name, phone,
      address_street, address_neighborhood, address_city, address_state,
      address_number, address_complement, zip_code,
      capacity, description, website, instagram_handle, facebook_handle,
      latitude, longitude,
      slug: rawSlug
    } = req.body;

    let slug = rawSlug ? normalizeStoreSlug(rawSlug) : normalizeStoreSlug(name);
    if (!slug) {
      slug = `store-${uuidv4().slice(0, 8)}`;
    }
    if (isReservedStoreSlug(slug)) {
      await t.rollback();
      return res.status(400).json({ error: 'Validation error', message: 'Slug inválido' });
    }
    if (slug.length < 3 || slug.length > 63) {
      await t.rollback();
      return res.status(400).json({ error: 'Validation error', message: 'Slug deve ter entre 3 e 63 caracteres' });
    }

    const existingSlug = await Store.findOne({ where: { slug }, transaction: t });
    if (existingSlug) {
      await t.rollback();
      return res.status(409).json({ error: 'Conflict', message: 'Slug já utilizado' });
    }

    const store = await Store.create({
      organization_id: org.id,
      owner_id: userId, // Store owner matches Org owner
      name,
      slug,
      email,
      cnpj,
      logo_url,
      banner_url,
      type,
      legal_name,
      phone,
      zip_code,
      address_street,
      address_neighborhood,
      city: address_city,
      address: address_street ? `${address_street}, ${address_number || ''} - ${address_neighborhood || ''}, ${address_city || ''} - ${address_state || ''}` : null, // Simple formatted address
      address_state,
      address_number,
      address_complement,
      capacity,
      description,
      website,
      instagram_handle,
      facebook_handle,
      latitude,
      longitude,
      config: { default: false },
      status: 'active'
    }, { transaction: t });

    // 4. Create Default Schedule (Closed 24/7 initially)
    const schedules = [];
    for (let i = 0; i < 7; i++) {
      schedules.push({
        store_id: store.id,
        day_of_week: i,
        is_open: false
      });
    }
    await StoreSchedule.bulkCreate(schedules, { transaction: t });

    // 5. Add Owner as Manager (Redundant if owner logic handles it, but safe)
    await StoreMember.create({
      store_id: store.id,
      user_id: userId,
      role: 'manager',
      permissions: ['*'],
      status: 'active'
    }, { transaction: t });

    await t.commit();

    res.status(201).json({
      success: true,
      message: 'Loja criada com sucesso',
      data: {
        id: store.id_code,
        name: store.name,
        slug: store.slug
      }
    });

  } catch (err) {
    await t.rollback();
    console.error('Error creating store in org:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/v1/organizations
// Create a new organization + Default Store
router.post('/', authenticateToken, [
  body('name').isString().notEmpty(),
  body('document').optional().isString(),
  body('logo_url').optional().isURL({ require_tld: false }),
  body('banner_url').optional().isURL({ require_tld: false })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

  const { name, document, logo_url, banner_url } = req.body;
  const userId = req.user.userId;

  try {
    // Check if user already has an active organization
    const existingOrg = await Organization.findOne({ where: { owner_id: userId, status: 'active' } });
    if (existingOrg) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Usuário já possui uma organização ativa. Para criar mais, contate o suporte ou use um plano superior.'
      });
    }

    // Transaction ideally
    const org = await Organization.create({
      owner_id: userId,
      name: name,
      document: document,
      logo_url: logo_url,
      banner_url: banner_url,
      plan_tier: 'free'
    });

    // Create Default Store (Matriz)
    const storeName = `${name} (Matriz)`;
    const base = normalizeStoreSlug(name);
    const slug = base ? `${base}-${uuidv4().substring(0, 8)}` : `store-${uuidv4().substring(0, 8)}`;

    const store = await Store.create({
      organization_id: org.id,
      owner_id: userId, // Define o owner da loja igual ao owner da organização
      name: storeName,
      slug: slug,
      config: { default: true }
    });

    // Add Owner as Manager of this Store
    await StoreMember.create({
      store_id: store.id,
      user_id: userId,
      role: 'manager',
      permissions: ['*'], // Full access
      status: 'active'
    });

    res.status(201).json({
      success: true,
      data: {
        organization: { id: org.id_code, name: org.name, logo_url: org.logo_url, banner_url: org.banner_url },
        store: { id: store.id_code, name: store.name, slug: store.slug }
      }
    });
  } catch (err) {
    console.error('Error creating organization:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/v1/organizations/:id_code
// Update organization details
router.put('/:id_code', authenticateToken, [
  body('name').optional().isString().notEmpty(),
  body('document').optional().isString(),
  body('logo_url').optional().isURL({ require_tld: false }),
  body('banner_url').optional().isURL({ require_tld: false })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

  const { id_code } = req.params;
  const userId = req.user.userId;

  try {
    const org = await Organization.findOne({ where: { id_code, owner_id: userId } });
    if (!org) return res.status(404).json({ error: 'Not Found', message: 'Organização não encontrada ou sem permissão' });

    await org.update(req.body);

    res.json({ success: true, data: org });
  } catch (err) {
    console.error('Error updating organization:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/v1/organizations/:id_code
// Soft delete (archive) organization
router.delete('/:id_code', authenticateToken, async (req, res) => {
  const { id_code } = req.params;
  const userId = req.user.userId;

  try {
    const org = await Organization.findOne({ where: { id_code, owner_id: userId } });
    if (!org) return res.status(404).json({ error: 'Not Found', message: 'Organização não encontrada ou sem permissão' });

    // Soft delete: Change status to 'archived' or 'suspended'
    // Assuming 'suspended' or 'archived' is in ENUM. Model defined: 'active', 'suspended', 'archived'
    await org.update({ status: 'archived' });

    // Optionally: Archive all stores? 
    // For now, just archiving the org is enough to block access if we check org status on login.

    res.json({ success: true, message: 'Organização arquivada com sucesso' });
  } catch (err) {
    console.error('Error deleting organization:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
