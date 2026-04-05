const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, requireModule } = require('../middlewares/auth');
const { requireStoreContext, requireStoreAccess } = require('../middlewares/storeContext');
const { requireStorePermission } = require('../middlewares/storePermissions');
const {
  sequelize,
  User,
  Store,
  StoreMember,
  StoreUser,
  Party,
  ProjectProject,
  ProjectMember,
  ProjectStage,
  ProjectTask,
  ProjectSession,
  ProjectTimeEntry,
  ProjectMemberCost,
  ProjectNotification
} = require('../models');

const router = express.Router();

const toDateOnly = (d) => d.toISOString().slice(0, 10);

router.get('/me/scope', authenticateToken, requireModule('project'), async (req, res) => {
  try {
    const userId = req.user.userId;

    const [projectMembers, storeMemberRows, storeUserRows, ownedStores] = await Promise.all([
      ProjectMember.findAll({
        where: { user_id: userId, status: 'active' },
        include: [{
          model: ProjectProject,
          as: 'project',
          attributes: ['id', 'id_code', 'store_id', 'title', 'logo_url', 'status', 'client_name', 'client_party_id', 'start_date', 'end_date'],
          required: true
        }],
        order: [['created_at', 'ASC']]
      }),
      StoreMember.findAll({
        where: { user_id: userId, status: 'active' },
        attributes: ['store_id', 'role', 'permissions'],
        include: [{ model: Store, as: 'store', attributes: ['id', 'id_code', 'name', 'slug', 'logo_url', 'banner_url'] }]
      }),
      StoreUser.findAll({
        where: { user_id: userId },
        attributes: ['store_id', 'role'],
        raw: true
      }),
      Store.findAll({
        where: { owner_id: userId },
        attributes: ['id', 'id_code', 'name', 'slug', 'logo_url', 'banner_url', 'owner_id'],
        raw: true
      })
    ]);

    const projectsByStoreIdCode = new Map();
    for (const pm of (projectMembers || [])) {
      const j = pm.toJSON();
      const p = j.project;
      if (!p || !p.store_id) continue;
      const storeIdCode = String(p.store_id);
      if (!projectsByStoreIdCode.has(storeIdCode)) projectsByStoreIdCode.set(storeIdCode, []);
      projectsByStoreIdCode.get(storeIdCode).push({
        id: p.id_code,
        id_code: p.id_code,
        title: p.title,
        logo_url: p.logo_url || null,
        status: p.status,
        client_name: p.client_name || null,
        client_party_id: p.client_party_id || null,
        start_date: p.start_date || null,
        end_date: p.end_date || null,
        my_role: j.role,
        my_status: j.status
      });
    }

    const storeIdsNeeded = Array.from(projectsByStoreIdCode.keys());
    if (!storeIdsNeeded.length) {
      return res.json({ success: true, data: [] });
    }

    const storeMetaByIdCode = new Map();
    const storeAccessByIdCode = new Map();

    for (const r of ownedStores || []) {
      storeMetaByIdCode.set(String(r.id_code), r);
      storeAccessByIdCode.set(String(r.id_code), { source: 'owner', role: 'owner', permissions: ['project:read', 'project:write'] });
    }

    for (const m of storeMemberRows || []) {
      const mj = m.toJSON();
      if (mj.store && mj.store.id_code) {
        storeMetaByIdCode.set(String(mj.store.id_code), mj.store);
        storeAccessByIdCode.set(String(mj.store.id_code), {
          source: 'store_member',
          role: mj.role,
          permissions: Array.isArray(mj.permissions) ? mj.permissions : []
        });
      }
    }

    const legacyStoreIds = Array.from(new Set((storeUserRows || []).map(r => r.store_id).filter(Boolean)));
    if (legacyStoreIds.length) {
      const legacyStores = await Store.findAll({
        where: { id: { [Op.in]: legacyStoreIds } },
        attributes: ['id', 'id_code', 'name', 'slug', 'logo_url', 'banner_url', 'owner_id'],
        raw: true
      });
      const legacyStoreById = new Map(legacyStores.map(s => [s.id, s]));
      for (const r of storeUserRows || []) {
        const s = legacyStoreById.get(r.store_id);
        if (!s) continue;
        storeMetaByIdCode.set(String(s.id_code), s);
        if (!storeAccessByIdCode.has(String(s.id_code))) {
          storeAccessByIdCode.set(String(s.id_code), { source: 'store_user', role: r.role, permissions: ['project:read'] });
        }
      }
    }

    const missingStoreIds = storeIdsNeeded.filter(id => !storeMetaByIdCode.has(id));
    if (missingStoreIds.length) {
      const rows = await Store.findAll({
        where: { id_code: { [Op.in]: missingStoreIds } },
        attributes: ['id', 'id_code', 'name', 'slug', 'logo_url', 'banner_url', 'owner_id'],
        raw: true
      });
      for (const r of rows) {
        storeMetaByIdCode.set(String(r.id_code), r);
      }
    }

    const data = storeIdsNeeded
      .map((storeIdCode) => {
        const store = storeMetaByIdCode.get(storeIdCode);
        if (!store) return null;
        const access = storeAccessByIdCode.get(storeIdCode) || null;
        return {
          store: {
            id: store.id_code,
            id_code: store.id_code,
            name: store.name,
            slug: store.slug || null,
            logo_url: store.logo_url || null,
            banner_url: store.banner_url || null,
            my_role: access ? access.role : null,
            my_permissions: access ? access.permissions : []
          },
          projects: projectsByStoreIdCode.get(storeIdCode) || []
        };
      })
      .filter(Boolean);

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Project scope error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

const getStoreRole = async (storeDbId, userId) => {
  const member = await StoreMember.findOne({
    where: { store_id: storeDbId, user_id: userId, status: 'active' },
    attributes: ['role'],
    raw: true
  });
  if (member && member.role) return String(member.role);
  const legacy = await StoreUser.findOne({ where: { store_id: storeDbId, user_id: userId }, attributes: ['role'], raw: true });
  if (legacy && legacy.role) return String(legacy.role);
  return null;
};

const isHighPrivilege = (role) => ['admin', 'master', 'masteradmin'].includes(role);

const resolveProjectByIdCode = async (storeId, idCode) => {
  return ProjectProject.findOne({ where: { store_id: storeId, id_code: idCode } });
};

const requireProjectMember = async (projectId, userId) => {
  return ProjectMember.findOne({
    where: { project_id: projectId, user_id: userId, status: 'active' }
  });
};

const getEffectiveCostRate = async ({ storeId, userId, projectId, at }) => {
  const date = toDateOnly(at);

  let memberOverride = null;
  if (projectId) {
    memberOverride = await ProjectMember.findOne({
      where: { project_id: projectId, user_id: userId, status: 'active' },
      attributes: ['hourly_rate_override', 'overhead_multiplier_override'],
      raw: true
    });
  }

  if (memberOverride && memberOverride.hourly_rate_override !== null) {
    const costCfg = await ProjectMemberCost.findOne({
      where: {
        store_id: storeId,
        user_id: userId,
        start_date: { [Op.lte]: date },
        [Op.or]: [{ end_date: null }, { end_date: { [Op.gte]: date } }]
      },
      order: [['start_date', 'DESC']]
    });
    const cfg = costCfg ? costCfg.toJSON() : {};
    return {
      hourly_rate: memberOverride.hourly_rate_override,
      overhead_multiplier: memberOverride.overhead_multiplier_override !== null ? memberOverride.overhead_multiplier_override : 1,
      daily_auto_cutoff_time: cfg.daily_auto_cutoff_time || '18:00:00',
      timezone: cfg.timezone || 'America/Sao_Paulo'
    };
  }

  const cost = await ProjectMemberCost.findOne({
    where: {
      store_id: storeId,
      user_id: userId,
      start_date: { [Op.lte]: date },
      [Op.or]: [{ end_date: null }, { end_date: { [Op.gte]: date } }]
    },
    order: [['start_date', 'DESC']]
  });

  if (!cost) return { hourly_rate: null, overhead_multiplier: null, daily_auto_cutoff_time: '18:00:00', timezone: 'America/Sao_Paulo' };

  const j = cost.toJSON();
  return {
    hourly_rate: j.hourly_rate,
    overhead_multiplier: j.overhead_multiplier,
    daily_auto_cutoff_time: j.daily_auto_cutoff_time || '18:00:00',
    timezone: j.timezone || 'America/Sao_Paulo'
  };
};

router.use(authenticateToken, requireModule('project'), requireStoreContext(), requireStoreAccess);

router.get(
  '/projects',
  requireStorePermission(['project:read', 'project:write']),
  [
    query('status').optional().isIn(['active', 'paused', 'finished']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    try {
      const page = req.query.page || 1;
      const limit = req.query.limit || 50;
      const offset = (page - 1) * limit;
      const where = { store_id: req.storeId };
      if (req.query.status) where.status = req.query.status;

      const storeRole = await getStoreRole(req.storeDbId, req.user.userId);
      const canSeeAll = isHighPrivilege(req.user.role) || storeRole === 'admin' || storeRole === 'manager';

      if (!canSeeAll) {
        const membershipRows = await ProjectMember.findAll({
          where: { store_id: req.storeId, user_id: req.user.userId, status: 'active' },
          attributes: ['project_id'],
          raw: true
        });
        const projectIds = membershipRows.map(r => r.project_id);
        where.id = projectIds.length ? { [Op.in]: projectIds } : -1;
      }

      const { count, rows } = await ProjectProject.findAndCountAll({
        where,
        order: [['updated_at', 'DESC']],
        offset,
        limit
      });

      const projectDbIds = rows.map(r => r.id);

      const [memberRows, stageRows] = await Promise.all([
        projectDbIds.length
          ? ProjectMember.findAll({
            where: { project_id: { [Op.in]: projectDbIds } },
            include: [{ model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'email', 'avatar_url'] }],
            order: [['created_at', 'ASC']]
          })
          : [],
        projectDbIds.length
          ? ProjectStage.findAll({
            where: { project_id: { [Op.in]: projectDbIds } },
            attributes: ['id', 'id_code', 'project_id', 'title', 'acronym', 'due_date', 'status', 'order_index', 'color_1', 'color_2'],
            order: [['project_id', 'ASC'], ['order_index', 'ASC'], ['created_at', 'ASC']]
          })
          : []
      ]);

      const membersByProjectId = new Map();
      for (const m of (memberRows || [])) {
        const mj = m && typeof m.toJSON === 'function' ? m.toJSON() : (m || {});
        const pid = mj.project_id;
        if (!membersByProjectId.has(pid)) membersByProjectId.set(pid, []);
        const role = mj.role || 'member';
        membersByProjectId.get(pid).push({
          id: mj.id_code,
          id_code: mj.id_code,
          role,
          status: mj.status || null,
          permissions: {
            can_view: true,
            can_track_time: role !== 'viewer',
            can_edit: role === 'manager'
          },
          user: mj.user ? { ...mj.user, id: mj.user.id_code } : null
        });
      }

      const stagesByProjectId = new Map();
      for (const s of (stageRows || [])) {
        const sj = s && typeof s.toJSON === 'function' ? s.toJSON() : (s || {});
        const pid = sj.project_id;
        if (!stagesByProjectId.has(pid)) stagesByProjectId.set(pid, []);
        stagesByProjectId.get(pid).push({
          id: sj.id_code,
          id_code: sj.id_code,
          title: sj.title,
          acronym: sj.acronym || null,
          due_date: sj.due_date || null,
          status: sj.status,
          order_index: sj.order_index,
          color_1: sj.color_1 || null,
          color_2: sj.color_2 || null
        });
      }

      return res.json({
        success: true,
        data: rows.map(r => {
          const j = r.toJSON();
          return {
            ...j,
            id: j.id_code,
            id_code: j.id_code,
            members: membersByProjectId.get(j.id) || [],
            stages: stagesByProjectId.get(j.id) || []
          };
        }),
        meta: { total: count, page, limit, pages: Math.ceil(count / limit) }
      });
    } catch (error) {
      console.error('List projects error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post(
  '/projects',
  requireStorePermission(['project:write']),
  [
    body().custom((_, { req }) => {
      const title = req.body && (req.body.title || req.body.name);
      if (!title) {
        throw new Error('title é obrigatório');
      }
      return true;
    }),
    body('title').optional({ nullable: true }).isLength({ min: 2, max: 255 }).trim(),
    body('name').optional({ nullable: true }).isLength({ min: 2, max: 255 }).trim(),
    body('client_name').optional({ nullable: true }).isString(),
    body('client_party_id').optional({ nullable: true }).isString(),
    body('logo_url').optional({ nullable: true }).isString(),
    body('responsible_name').optional({ nullable: true }).isString(),
    body('start_date').optional({ nullable: true }).isISO8601(),
    body('end_date').optional({ nullable: true }).isISO8601(),
    body('description').optional({ nullable: true }).isString(),
    body('status').optional({ nullable: true }).isIn(['active', 'paused', 'finished', 'published']),
    body('overhead_multiplier').optional({ nullable: true }).isFloat({ min: 0.1, max: 10 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    try {
      const t = await sequelize.transaction();
      try {
        const normalizeStatus = (value) => {
          const v = String(value || '').trim().toLowerCase();
          if (!v) return 'active';
          if (v === 'published') return 'active';
          return v;
        };

        const title = (req.body.title || req.body.name || '').trim();
        let clientParty = null;
        if (req.body.client_party_id) {
          clientParty = await Party.findOne({
            where: { id_code: req.body.client_party_id, store_id: req.storeId, is_customer: true }
          });
          if (!clientParty) {
            return res.status(404).json({ error: 'Not Found', message: 'Cliente não encontrado' });
          }
        }

        const project = await ProjectProject.create({
          store_id: req.storeId,
          client_name: req.body.client_name || (clientParty ? clientParty.name : null),
          client_party_id: clientParty ? clientParty.id_code : (req.body.client_party_id || null),
          title,
          description: req.body.description || null,
          logo_url: req.body.logo_url || null,
          responsible_name: req.body.responsible_name || null,
          start_date: req.body.start_date ? toDateOnly(new Date(req.body.start_date)) : null,
          end_date: req.body.end_date ? toDateOnly(new Date(req.body.end_date)) : null,
          status: normalizeStatus(req.body.status),
          overhead_multiplier: req.body.overhead_multiplier !== undefined ? req.body.overhead_multiplier : 1,
          created_by_user_id: req.user.userId
        }, { transaction: t });

        await ProjectMember.create({
          store_id: req.storeId,
          project_id: project.id,
          user_id: req.user.userId,
          role: 'manager',
          status: 'active',
          start_date: toDateOnly(new Date())
        }, { transaction: t });

        await t.commit();
        const j = project.toJSON();
        return res.status(201).json({ success: true, data: { project: { ...j, id: j.id_code } } });
      } catch (err) {
        await t.rollback();
        throw err;
      }
    } catch (error) {
      console.error('Create project error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.get('/projects/:id_code', requireStorePermission(['project:read', 'project:write']), async (req, res) => {
  try {
    const project = await resolveProjectByIdCode(req.storeId, req.params.id_code);
    if (!project) return res.status(404).json({ error: 'Not Found', message: 'Projeto não encontrado' });

    const storeRole = await getStoreRole(req.storeDbId, req.user.userId);
    const canSeeAll = isHighPrivilege(req.user.role) || storeRole === 'admin' || storeRole === 'manager';
    if (!canSeeAll) {
      const member = await requireProjectMember(project.id, req.user.userId);
      if (!member) return res.status(403).json({ error: 'Forbidden', message: 'Sem acesso a este projeto' });
    }

    const stages = await ProjectStage.findAll({
      where: { project_id: project.id },
      order: [['order_index', 'ASC'], ['created_at', 'ASC']]
    });

    const members = await ProjectMember.findAll({
      where: { project_id: project.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'id_code', 'name', 'email', 'avatar_url'] }],
      order: [['created_at', 'ASC']]
    });

    return res.json({
      success: true,
      data: {
        project: { ...project.toJSON(), id: project.id_code },
        stages: stages.map(s => ({ ...s.toJSON(), id: s.id_code })),
        members: members.map(m => {
          const j = m.toJSON();
          return {
            ...j,
            id: j.id_code,
            user: j.user ? { ...j.user, id: j.user.id_code } : null
          };
        })
      }
    });
  } catch (error) {
    console.error('Get project error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.patch(
  '/projects/:id_code',
  requireStorePermission(['project:write']),
  [
    body('title').optional({ nullable: true }).isLength({ min: 2, max: 255 }).trim(),
    body('name').optional({ nullable: true }).isLength({ min: 2, max: 255 }).trim(),
    body('client_name').optional({ nullable: true }).isString(),
    body('client_party_id').optional({ nullable: true }).custom((value) => value === null || typeof value === 'string'),
    body('logo_url').optional({ nullable: true }).custom((value) => value === null || typeof value === 'string'),
    body('responsible_name').optional({ nullable: true }).custom((value) => value === null || typeof value === 'string'),
    body('start_date').optional({ nullable: true }).custom((value) => value === null || value === '' || !Number.isNaN(Date.parse(value))),
    body('end_date').optional({ nullable: true }).custom((value) => value === null || value === '' || !Number.isNaN(Date.parse(value))),
    body('description').optional({ nullable: true }).custom((value) => value === null || typeof value === 'string'),
    body('status').optional({ nullable: true }).isIn(['active', 'paused', 'finished', 'published']),
    body('overhead_multiplier').optional({ nullable: true }).isFloat({ min: 0.1, max: 10 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation error', details: errors.array() });
    }

    try {
      const project = await resolveProjectByIdCode(req.storeId, req.params.id_code);
      if (!project) return res.status(404).json({ error: 'Not Found', message: 'Projeto não encontrado' });

      const storeRole = await getStoreRole(req.storeDbId, req.user.userId);
      const canWriteAll = isHighPrivilege(req.user.role) || storeRole === 'admin' || storeRole === 'manager';

      if (!canWriteAll) {
        const member = await ProjectMember.findOne({
          where: { project_id: project.id, user_id: req.user.userId, status: 'active', role: 'manager' }
        });
        if (!member) return res.status(403).json({ error: 'Forbidden', message: 'Sem permissão para editar este projeto' });
      }

      const normalizeStatus = (value) => {
        const v = String(value || '').trim().toLowerCase();
        if (!v) return null;
        if (v === 'published') return 'active';
        return v;
      };

      const patch = {};
      if (req.body.title !== undefined || req.body.name !== undefined) {
        const title = String(req.body.title || req.body.name || '').trim();
        if (!title) return res.status(400).json({ error: 'Validation error', message: 'title é obrigatório' });
        patch.title = title;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, 'description')) patch.description = req.body.description === null ? null : req.body.description;
      if (Object.prototype.hasOwnProperty.call(req.body, 'logo_url')) patch.logo_url = req.body.logo_url === null ? null : req.body.logo_url;
      if (Object.prototype.hasOwnProperty.call(req.body, 'responsible_name')) patch.responsible_name = req.body.responsible_name === null ? null : req.body.responsible_name;
      if (Object.prototype.hasOwnProperty.call(req.body, 'start_date')) patch.start_date = req.body.start_date ? toDateOnly(new Date(req.body.start_date)) : null;
      if (Object.prototype.hasOwnProperty.call(req.body, 'end_date')) patch.end_date = req.body.end_date ? toDateOnly(new Date(req.body.end_date)) : null;
      if (Object.prototype.hasOwnProperty.call(req.body, 'overhead_multiplier')) patch.overhead_multiplier = req.body.overhead_multiplier;

      if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
        const st = normalizeStatus(req.body.status);
        if (st) patch.status = st;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'client_party_id')) {
        if (req.body.client_party_id === null || req.body.client_party_id === '') {
          patch.client_party_id = null;
        } else {
          const clientParty = await Party.findOne({
            where: { id_code: req.body.client_party_id, store_id: req.storeId, is_customer: true }
          });
          if (!clientParty) {
            return res.status(404).json({ error: 'Not Found', message: 'Cliente não encontrado' });
          }
          patch.client_party_id = clientParty.id_code;
          if (!Object.prototype.hasOwnProperty.call(req.body, 'client_name')) {
            patch.client_name = clientParty.name;
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'client_name')) {
        patch.client_name = req.body.client_name === null ? null : req.body.client_name;
      }

      await project.update(patch);
      const j = project.toJSON();
      return res.json({ success: true, data: { project: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Patch project error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post(
  '/projects/:id_code/members',
  requireStorePermission(['project:write']),
  [
    body('user_id').isString(),
    body('role').optional({ nullable: true }).isIn(['manager', 'member', 'viewer']),
    body('status').optional({ nullable: true }).isIn(['active', 'inactive'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const project = await resolveProjectByIdCode(req.storeId, req.params.id_code);
      if (!project) return res.status(404).json({ error: 'Not Found', message: 'Projeto não encontrado' });

      let user = await User.findOne({ where: { id_code: req.body.user_id } });
      if (!user) {
        const storeMember = await StoreMember.findOne({
          where: { id_code: req.body.user_id, store_id: req.storeDbId, status: 'active' }
        });
        if (!storeMember) return res.status(404).json({ error: 'Not Found', message: 'Usuário não encontrado' });
        if (!storeMember.user_id) {
          return res.status(409).json({ error: 'Conflict', message: 'Usuário ainda não aceitou o convite da unidade' });
        }
        user = await User.findByPk(storeMember.user_id);
        if (!user) return res.status(404).json({ error: 'Not Found', message: 'Usuário não encontrado' });
      }

      if (!user.id_code) {
        await user.update({ id_code: uuidv4() });
      }

      const existing = await ProjectMember.findOne({ where: { project_id: project.id, user_id: user.id } });
      if (existing) {
        await existing.update({
          status: req.body.status || 'active',
          role: req.body.role || existing.role
        });
        const j = existing.toJSON();
        return res.json({ success: true, data: { member: { ...j, id: j.id_code } } });
      }

      const member = await ProjectMember.create({
        store_id: req.storeId,
        project_id: project.id,
        user_id: user.id,
        role: req.body.role || 'member',
        status: req.body.status || 'active',
        start_date: toDateOnly(new Date())
      });

      const j = member.toJSON();
      return res.status(201).json({ success: true, data: { member: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Add project member error:', error);
      if (error.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: 'Conflict', message: 'Membro já existe no projeto' });
      }
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.delete('/projects/:id_code/members/:member_id', requireStorePermission(['project:write']), async (req, res) => {
  try {
    const project = await resolveProjectByIdCode(req.storeId, req.params.id_code);
    if (!project) return res.status(404).json({ error: 'Not Found', message: 'Projeto não encontrado' });

    const member = await ProjectMember.findOne({ where: { id_code: req.params.member_id, project_id: project.id } });
    if (!member) return res.status(404).json({ error: 'Not Found', message: 'Membro não encontrado' });

    await member.update({ status: 'inactive', end_date: toDateOnly(new Date()) });
    return res.json({ success: true });
  } catch (error) {
    console.error('Remove project member error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.get(
  '/member-costs',
  requireStorePermission(['project:read', 'project:write']),
  [query('user_id').optional().isString()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const where = { store_id: req.storeId };
      if (req.query.user_id) {
        const user = await User.findOne({ where: { id_code: req.query.user_id } });
        if (!user) return res.status(404).json({ error: 'Not Found', message: 'Usuário não encontrado' });
        where.user_id = user.id;
      }
      const rows = await ProjectMemberCost.findAll({ where, order: [['user_id', 'ASC'], ['start_date', 'DESC']] });
      return res.json({
        success: true,
        data: rows.map(r => {
          const j = r.toJSON();
          return { ...j, id: j.id_code };
        })
      });
    } catch (error) {
      console.error('List member costs error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post(
  '/member-costs',
  requireStorePermission(['project:write']),
  [
    body('user_id').isString(),
    body('hourly_rate').isFloat({ min: 0 }).toFloat(),
    body('overhead_multiplier').optional({ nullable: true }).isFloat({ min: 0.1, max: 10 }).toFloat(),
    body('start_date').isISO8601(),
    body('end_date').optional({ nullable: true }).isISO8601(),
    body('daily_auto_cutoff_time').optional({ nullable: true }).isString(),
    body('timezone').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const user = await User.findOne({ where: { id_code: req.body.user_id } });
      if (!user) return res.status(404).json({ error: 'Not Found', message: 'Usuário não encontrado' });

      const row = await ProjectMemberCost.create({
        store_id: req.storeId,
        user_id: user.id,
        hourly_rate: req.body.hourly_rate,
        overhead_multiplier: req.body.overhead_multiplier !== undefined && req.body.overhead_multiplier !== null ? req.body.overhead_multiplier : 1,
        daily_auto_cutoff_time: req.body.daily_auto_cutoff_time || '18:00:00',
        timezone: req.body.timezone || 'America/Sao_Paulo',
        start_date: toDateOnly(new Date(req.body.start_date)),
        end_date: req.body.end_date ? toDateOnly(new Date(req.body.end_date)) : null
      });

      const j = row.toJSON();
      return res.status(201).json({ success: true, data: { member_cost: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Create member cost error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.patch(
  '/member-costs/:id_code',
  requireStorePermission(['project:write']),
  [
    body('hourly_rate').optional().isFloat({ min: 0 }).toFloat(),
    body('overhead_multiplier').optional({ nullable: true }).isFloat({ min: 0.1, max: 10 }).toFloat(),
    body('start_date').optional().isISO8601(),
    body('end_date').optional({ nullable: true }).isISO8601(),
    body('daily_auto_cutoff_time').optional({ nullable: true }).isString(),
    body('timezone').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const row = await ProjectMemberCost.findOne({ where: { store_id: req.storeId, id_code: req.params.id_code } });
      if (!row) return res.status(404).json({ error: 'Not Found', message: 'Registro não encontrado' });

      const patch = {};
      if (req.body.hourly_rate !== undefined) patch.hourly_rate = req.body.hourly_rate;
      if (req.body.overhead_multiplier !== undefined) patch.overhead_multiplier = req.body.overhead_multiplier;
      if (req.body.daily_auto_cutoff_time !== undefined) patch.daily_auto_cutoff_time = req.body.daily_auto_cutoff_time;
      if (req.body.timezone !== undefined) patch.timezone = req.body.timezone;
      if (req.body.start_date !== undefined) patch.start_date = toDateOnly(new Date(req.body.start_date));
      if (Object.prototype.hasOwnProperty.call(req.body, 'end_date')) patch.end_date = req.body.end_date ? toDateOnly(new Date(req.body.end_date)) : null;

      await row.update(patch);
      const j = row.toJSON();
      return res.json({ success: true, data: { member_cost: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Patch member cost error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post(
  '/projects/:id_code/stages',
  requireStorePermission(['project:write']),
  [
    body('title').isLength({ min: 2, max: 255 }).trim(),
    body('acronym').optional({ nullable: true }).isString(),
    body('contract_value').optional({ nullable: true }).isFloat({ min: 0 }),
    body('estimated_hours').optional({ nullable: true }).isInt({ min: 0 }).toInt(),
    body('start_date').optional({ nullable: true }).isISO8601(),
    body('due_date').optional({ nullable: true }).isISO8601(),
    body('status').optional({ nullable: true }).isIn(['planned', 'active', 'completed']),
    body('color_1').optional({ nullable: true }).isString(),
    body('color_2').optional({ nullable: true }).isString(),
    body('order_index').optional({ nullable: true }).isInt().toInt()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const project = await resolveProjectByIdCode(req.storeId, req.params.id_code);
      if (!project) return res.status(404).json({ error: 'Not Found', message: 'Projeto não encontrado' });

      const stage = await ProjectStage.create({
        project_id: project.id,
        title: req.body.title,
        acronym: req.body.acronym || null,
        contract_value: req.body.contract_value !== undefined ? req.body.contract_value : null,
        estimated_hours: req.body.estimated_hours !== undefined ? req.body.estimated_hours : null,
        start_date: req.body.start_date ? toDateOnly(new Date(req.body.start_date)) : null,
        due_date: req.body.due_date ? toDateOnly(new Date(req.body.due_date)) : null,
        status: req.body.status || 'planned',
        color_1: req.body.color_1 || null,
        color_2: req.body.color_2 || null,
        completed_at: req.body.status === 'completed' ? new Date() : null,
        order_index: req.body.order_index !== undefined ? req.body.order_index : 0
      });

      const j = stage.toJSON();
      return res.status(201).json({ success: true, data: { stage: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Create stage error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post(
  '/stages/:id_code/tasks',
  requireStorePermission(['project:write']),
  [
    body('title').isLength({ min: 2, max: 255 }).trim(),
    body('description').optional({ nullable: true }).isString(),
    body('status').optional({ nullable: true }).isIn(['todo', 'doing', 'done', 'blocked']),
    body('assigned_user_id').optional({ nullable: true }).isString(),
    body('due_date').optional({ nullable: true }).isISO8601(),
    body('order_index').optional({ nullable: true }).isInt().toInt()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const stage = await ProjectStage.findOne({
        where: { id_code: req.params.id_code },
        include: [{ model: ProjectProject, as: 'project' }]
      });
      if (!stage || !stage.project || stage.project.store_id !== req.storeId) {
        return res.status(404).json({ error: 'Not Found', message: 'Etapa não encontrada' });
      }

      let assignedUserId = null;
      if (req.body.assigned_user_id) {
        const user = await User.findOne({ where: { id_code: req.body.assigned_user_id } });
        if (!user) return res.status(404).json({ error: 'Not Found', message: 'Usuário não encontrado' });
        assignedUserId = user.id;
      }

      const task = await ProjectTask.create({
        stage_id: stage.id,
        title: req.body.title,
        description: req.body.description || null,
        status: req.body.status || 'todo',
        assigned_user_id: assignedUserId,
        due_date: req.body.due_date ? toDateOnly(new Date(req.body.due_date)) : null,
        order_index: req.body.order_index !== undefined ? req.body.order_index : 0
      });

      const j = task.toJSON();
      return res.status(201).json({ success: true, data: { task: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Create task error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post(
  '/sessions/check-in',
  requireStorePermission(['project:read', 'project:write']),
  [
    body('source').optional({ nullable: true }).isString(),
    body('device_id').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const open = await ProjectSession.findOne({
        where: { store_id: req.storeId, user_id: req.user.userId, check_out_at: null },
        order: [['check_in_at', 'DESC']]
      });
      if (open) {
        return res.json({ success: true, data: { session_id: open.id_code, already_checked_in: true } });
      }

      const now = new Date();
      const session = await ProjectSession.create({
        store_id: req.storeId,
        user_id: req.user.userId,
        check_in_at: now,
        check_out_at: null,
        source: req.body.source || null,
        device_id: req.body.device_id || null
      });

      return res.status(201).json({ success: true, data: { session_id: session.id_code } });
    } catch (error) {
      console.error('Session check-in error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post('/sessions/check-out', requireStorePermission(['project:read', 'project:write']), async (req, res) => {
  try {
    const session = await ProjectSession.findOne({
      where: { store_id: req.storeId, user_id: req.user.userId, check_out_at: null },
      order: [['check_in_at', 'DESC']]
    });
    if (!session) {
      return res.status(404).json({ error: 'Not Found', message: 'Sessão ativa não encontrada' });
    }

    const now = new Date();
    await sequelize.transaction(async (t) => {
      await ProjectTimeEntry.update(
        { end_at: now, status: 'closed' },
        { where: { session_id: session.id, status: 'running' }, transaction: t }
      );
      await session.update({ check_out_at: now, check_out_source: 'user', check_out_reason: null }, { transaction: t });
    });

    return res.json({ success: true, data: { session_id: session.id_code, check_out_at: now } });
  } catch (error) {
    console.error('Session check-out error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post(
  '/time-entries/start',
  requireStorePermission(['project:read', 'project:write']),
  [
    body('project_id').optional({ nullable: true }).isString(),
    body('stage_id').optional({ nullable: true }).isString(),
    body('task_id').optional({ nullable: true }).isString(),
    body('description').optional({ nullable: true }).isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const session = await ProjectSession.findOne({
        where: { store_id: req.storeId, user_id: req.user.userId, check_out_at: null },
        order: [['check_in_at', 'DESC']]
      });
      if (!session) return res.status(400).json({ error: 'Validation error', message: 'Check-in obrigatório' });

      const running = await ProjectTimeEntry.findOne({
        where: { store_id: req.storeId, user_id: req.user.userId, status: 'running' }
      });
      if (running) {
        return res.status(409).json({ error: 'Conflict', message: 'Já existe um apontamento em andamento', time_entry_id: running.id_code });
      }

      let project = null;
      let stage = null;
      let task = null;

      if (req.body.project_id) {
        project = await resolveProjectByIdCode(req.storeId, req.body.project_id);
        if (!project) return res.status(404).json({ error: 'Not Found', message: 'Projeto não encontrado' });
      }

      if (req.body.stage_id) {
        stage = await ProjectStage.findOne({
          where: { id_code: req.body.stage_id },
          include: [{ model: ProjectProject, as: 'project' }]
        });
        if (!stage || !stage.project || stage.project.store_id !== req.storeId) {
          return res.status(404).json({ error: 'Not Found', message: 'Etapa não encontrada' });
        }
        if (project && stage.project_id !== project.id) {
          return res.status(400).json({ error: 'Validation error', message: 'Etapa não pertence ao projeto' });
        }
        project = project || stage.project;
      }

      if (req.body.task_id) {
        task = await ProjectTask.findOne({
          where: { id_code: req.body.task_id },
          include: [{ model: ProjectStage, as: 'stage', include: [{ model: ProjectProject, as: 'project' }] }]
        });
        if (!task || !task.stage || !task.stage.project || task.stage.project.store_id !== req.storeId) {
          return res.status(404).json({ error: 'Not Found', message: 'Tarefa não encontrada' });
        }
        if (stage && task.stage_id !== stage.id) {
          return res.status(400).json({ error: 'Validation error', message: 'Tarefa não pertence à etapa' });
        }
        stage = stage || task.stage;
        project = project || task.stage.project;
      }

      if (project) {
        const member = await requireProjectMember(project.id, req.user.userId);
        if (!member) return res.status(403).json({ error: 'Forbidden', message: 'Você não faz parte deste projeto' });
      }

      const now = new Date();
      const timeEntry = await ProjectTimeEntry.create({
        store_id: req.storeId,
        session_id: session.id,
        user_id: req.user.userId,
        project_id: project ? project.id : null,
        stage_id: stage ? stage.id : null,
        task_id: task ? task.id : null,
        status: 'running',
        start_at: now,
        end_at: null,
        last_heartbeat_at: now,
        description: req.body.description || null
      });

      return res.status(201).json({ success: true, data: { time_entry_id: timeEntry.id_code } });
    } catch (error) {
      console.error('Start time entry error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.post('/time-entries/:id_code/stop', requireStorePermission(['project:read', 'project:write']), async (req, res) => {
  try {
    const timeEntry = await ProjectTimeEntry.findOne({
      where: { store_id: req.storeId, user_id: req.user.userId, id_code: req.params.id_code }
    });
    if (!timeEntry) return res.status(404).json({ error: 'Not Found', message: 'Apontamento não encontrado' });
    if (timeEntry.status !== 'running') return res.status(400).json({ error: 'Validation error', message: 'Apontamento não está em andamento' });

    const now = new Date();
    const start = new Date(timeEntry.start_at);
    const minutes = Math.max(0, Math.round((now.getTime() - start.getTime()) / 60000));
    const hours = minutes / 60;

    const project = timeEntry.project_id ? await ProjectProject.findByPk(timeEntry.project_id) : null;
    const rate = await getEffectiveCostRate({
      storeId: req.storeId,
      userId: req.user.userId,
      projectId: timeEntry.project_id || null,
      at: start
    });

    const hourlyRate = rate.hourly_rate !== null ? Number(rate.hourly_rate) : null;
    const overheadMultiplier = rate.overhead_multiplier !== null ? Number(rate.overhead_multiplier) : null;
    const projectOverhead = project ? Number(project.overhead_multiplier) : 1;
    const effectiveMultiplier = overheadMultiplier !== null ? overheadMultiplier : 1;
    const costAmount = hourlyRate !== null
      ? Number((hours * hourlyRate * effectiveMultiplier * projectOverhead).toFixed(2))
      : null;

    await timeEntry.update({
      end_at: now,
      status: 'closed',
      end_source: 'user',
      end_reason: null,
      minutes,
      hourly_rate_snapshot: hourlyRate,
      overhead_multiplier_snapshot: effectiveMultiplier * projectOverhead,
      cost_amount_snapshot: costAmount
    });

    return res.json({
      success: true,
      data: {
        time_entry_id: timeEntry.id_code,
        status: 'closed',
        minutes,
        cost_amount_snapshot: costAmount
      }
    });
  } catch (error) {
    console.error('Stop time entry error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.post('/time-entries/:id_code/heartbeat', requireStorePermission(['project:read', 'project:write']), async (req, res) => {
  try {
    const timeEntry = await ProjectTimeEntry.findOne({
      where: { store_id: req.storeId, user_id: req.user.userId, id_code: req.params.id_code }
    });
    if (!timeEntry) return res.status(404).json({ error: 'Not Found', message: 'Apontamento não encontrado' });
    if (timeEntry.status !== 'running') return res.status(400).json({ error: 'Validation error', message: 'Apontamento não está em andamento' });

    const now = new Date();
    await timeEntry.update({ last_heartbeat_at: now });

    const start = new Date(timeEntry.start_at);
    const minutes = Math.max(0, Math.round((now.getTime() - start.getTime()) / 60000));

    return res.json({
      success: true,
      data: {
        time_entry_id: timeEntry.id_code,
        server_now: now.toISOString(),
        start_at: timeEntry.start_at,
        minutes_estimated: minutes
      }
    });
  } catch (error) {
    console.error('Heartbeat time entry error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.get('/me/today', requireStorePermission(['project:read', 'project:write']), async (req, res) => {
  try {
    const now = new Date();
    const startOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    const endOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    const date = toDateOnly(now);

    const [openSession, runningEntry, closedEntries] = await Promise.all([
      ProjectSession.findOne({
        where: { store_id: req.storeId, user_id: req.user.userId, check_out_at: null },
        order: [['check_in_at', 'DESC']]
      }),
      ProjectTimeEntry.findOne({
        where: { store_id: req.storeId, user_id: req.user.userId, status: 'running' },
        order: [['start_at', 'DESC']]
      }),
      ProjectTimeEntry.findAll({
        where: {
          store_id: req.storeId,
          user_id: req.user.userId,
          status: 'closed',
          start_at: { [Op.between]: [startOfDayUtc, endOfDayUtc] }
        },
        attributes: ['minutes', 'cost_amount_snapshot']
      })
    ]);

    const confirmedMinutes = (closedEntries || []).reduce((acc, e) => acc + (Number(e.minutes) || 0), 0);
    const confirmedAmount = Number((closedEntries || []).reduce((acc, e) => acc + (Number(e.cost_amount_snapshot) || 0), 0).toFixed(2));

    let running = null;
    let estimatedMinutes = 0;
    let estimatedAmount = 0;
    if (runningEntry) {
      const startAt = new Date(runningEntry.start_at);
      estimatedMinutes = Math.max(0, Math.round((now.getTime() - startAt.getTime()) / 60000));

      const rate = await getEffectiveCostRate({
        storeId: req.storeId,
        userId: req.user.userId,
        projectId: runningEntry.project_id || null,
        at: startAt
      });

      const project = runningEntry.project_id ? await ProjectProject.findByPk(runningEntry.project_id) : null;
      const projectOverhead = project ? Number(project.overhead_multiplier || 1) : 1;
      const hourlyRate = rate.hourly_rate !== null ? Number(rate.hourly_rate) : null;
      const overheadMultiplier = rate.overhead_multiplier !== null ? Number(rate.overhead_multiplier) : 1;
      if (hourlyRate !== null) {
        const hours = estimatedMinutes / 60;
        estimatedAmount = Number((hours * hourlyRate * overheadMultiplier * projectOverhead).toFixed(2));
      }

      running = {
        id: runningEntry.id_code,
        id_code: runningEntry.id_code,
        start_at: runningEntry.start_at,
        minutes_estimated: estimatedMinutes,
        server_now: now.toISOString()
      };
    }

    return res.json({
      success: true,
      data: {
        date,
        server_now: now.toISOString(),
        session: openSession ? { id: openSession.id_code, id_code: openSession.id_code, check_in_at: openSession.check_in_at } : null,
        running
      },
      meta: {
        totals: {
          confirmed_minutes: confirmedMinutes,
          estimated_minutes: estimatedMinutes,
          confirmed_amount: confirmedAmount,
          estimated_amount: estimatedAmount,
          predicted_amount: Number((confirmedAmount + estimatedAmount).toFixed(2))
        }
      }
    });
  } catch (error) {
    console.error('Get today status error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
  }
});

router.get(
  '/me/timesheet',
  requireStorePermission(['project:read', 'project:write']),
  [
    query('start_date').isISO8601(),
    query('end_date').isISO8601()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const startDate = toDateOnly(new Date(req.query.start_date));
      const endDate = toDateOnly(new Date(req.query.end_date));
      const startAt = new Date(`${startDate}T00:00:00.000Z`);
      const endAt = new Date(`${endDate}T23:59:59.999Z`);

      const sessions = await ProjectSession.findAll({
        where: {
          store_id: req.storeId,
          user_id: req.user.userId,
          check_in_at: { [Op.between]: [startAt, endAt] }
        },
        order: [['check_in_at', 'ASC']]
      });

      const sessionIds = sessions.map(s => s.id);
      const entries = sessionIds.length ? await ProjectTimeEntry.findAll({
        where: { store_id: req.storeId, user_id: req.user.userId, session_id: { [Op.in]: sessionIds } },
        order: [['start_at', 'ASC']]
      }) : [];

      const projectIds = Array.from(new Set(entries.map(e => e.project_id).filter(Boolean)));
      const projects = projectIds.length
        ? await ProjectProject.findAll({ where: { id: { [Op.in]: projectIds } }, attributes: ['id', 'id_code', 'title', 'overhead_multiplier'], raw: true })
        : [];
      const projectById = new Map(projects.map(p => [p.id, p]));

      const stageIds = Array.from(new Set(entries.map(e => e.stage_id).filter(Boolean)));
      const stages = stageIds.length
        ? await ProjectStage.findAll({ where: { id: { [Op.in]: stageIds } }, attributes: ['id', 'id_code', 'title', 'acronym'], raw: true })
        : [];
      const stageById = new Map(stages.map(s => [s.id, s]));

      const taskIds = Array.from(new Set(entries.map(e => e.task_id).filter(Boolean)));
      const tasks = taskIds.length
        ? await ProjectTask.findAll({ where: { id: { [Op.in]: taskIds } }, attributes: ['id', 'id_code', 'title', 'status'], raw: true })
        : [];
      const taskById = new Map(tasks.map(t => [t.id, t]));

      const now = new Date();

      const computeCost = async (entry, minutes, atDate) => {
        const project = entry.project_id ? projectById.get(entry.project_id) : null;
        const projectOverhead = project ? Number(project.overhead_multiplier || 1) : 1;

        if (entry.cost_amount_snapshot !== null && entry.cost_amount_snapshot !== undefined) {
          return Number(entry.cost_amount_snapshot);
        }

        const rate = await getEffectiveCostRate({
          storeId: req.storeId,
          userId: req.user.userId,
          projectId: entry.project_id || null,
          at: atDate
        });

        const hourlyRate = rate.hourly_rate !== null ? Number(rate.hourly_rate) : null;
        const overheadMultiplier = rate.overhead_multiplier !== null ? Number(rate.overhead_multiplier) : 1;
        if (hourlyRate === null) return null;
        const hours = minutes / 60;
        return Number((hours * hourlyRate * overheadMultiplier * projectOverhead).toFixed(2));
      };

      const days = new Map();
      const ensureDay = (date) => {
        if (!days.has(date)) {
          days.set(date, { date, sessions: [], entries: [], totals: { confirmed_minutes: 0, estimated_minutes: 0, confirmed_amount: 0, estimated_amount: 0 } });
        }
        return days.get(date);
      };

      const entriesBySession = new Map();
      for (const e of entries) {
        const list = entriesBySession.get(e.session_id) || [];
        list.push(e);
        entriesBySession.set(e.session_id, list);
      }

      for (const s of sessions) {
        const sj = s.toJSON();
        const dayKey = toDateOnly(new Date(sj.check_in_at));
        const day = ensureDay(dayKey);

        day.sessions.push({
          id: sj.id_code,
          check_in_at: sj.check_in_at,
          check_out_at: sj.check_out_at,
          check_out_source: sj.check_out_source || null,
          check_out_reason: sj.check_out_reason || null,
          source: sj.source || null
        });

        const sesEntries = entriesBySession.get(s.id) || [];
        for (const e of sesEntries) {
          const ej = e.toJSON();
          const start = new Date(ej.start_at);
          const end = ej.status === 'closed' ? new Date(ej.end_at || ej.start_at) : now;
          const minutes = ej.status === 'closed'
            ? (ej.minutes !== null && ej.minutes !== undefined ? Number(ej.minutes) : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000)))
            : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
          const amount = await computeCost(ej, minutes, start);

          const project = ej.project_id ? projectById.get(ej.project_id) : null;
          const stage = ej.stage_id ? stageById.get(ej.stage_id) : null;
          const task = ej.task_id ? taskById.get(ej.task_id) : null;

          day.entries.push({
            id: ej.id_code,
            status: ej.status,
            start_at: ej.start_at,
            end_at: ej.end_at,
            minutes,
            amount,
            project: project ? { id: project.id_code, title: project.title } : null,
            stage: stage ? { id: stage.id_code, title: stage.title, acronym: stage.acronym } : null,
            task: task ? { id: task.id_code, title: task.title, status: task.status } : null,
            description: ej.description || null,
            is_estimated: ej.status !== 'closed'
          });

          if (ej.status === 'closed') {
            day.totals.confirmed_minutes += minutes;
            if (amount !== null) day.totals.confirmed_amount += amount;
          } else {
            day.totals.estimated_minutes += minutes;
            if (amount !== null) day.totals.estimated_amount += amount;
          }
        }
      }

      const data = Array.from(days.values()).map(d => {
        const confirmed_amount = Number(d.totals.confirmed_amount.toFixed(2));
        const estimated_amount = Number(d.totals.estimated_amount.toFixed(2));
        return {
          date: d.date,
          sessions: d.sessions,
          entries: d.entries,
          totals: {
            confirmed_minutes: d.totals.confirmed_minutes,
            estimated_minutes: d.totals.estimated_minutes,
            confirmed_amount,
            estimated_amount,
            predicted_amount: Number((confirmed_amount + estimated_amount).toFixed(2))
          }
        };
      });

      const totals = data.reduce((acc, d) => {
        acc.confirmed_minutes += d.totals.confirmed_minutes;
        acc.estimated_minutes += d.totals.estimated_minutes;
        acc.confirmed_amount += d.totals.confirmed_amount;
        acc.estimated_amount += d.totals.estimated_amount;
        return acc;
      }, { confirmed_minutes: 0, estimated_minutes: 0, confirmed_amount: 0, estimated_amount: 0 });

      const confirmed_amount = Number(totals.confirmed_amount.toFixed(2));
      const estimated_amount = Number(totals.estimated_amount.toFixed(2));

      return res.json({
        success: true,
        data,
        meta: {
          start_date: startDate,
          end_date: endDate,
          totals: {
            confirmed_minutes: totals.confirmed_minutes,
            estimated_minutes: totals.estimated_minutes,
            confirmed_amount,
            estimated_amount,
            predicted_amount: Number((confirmed_amount + estimated_amount).toFixed(2))
          }
        }
      });
    } catch (error) {
      console.error('Get timesheet error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.get(
  '/me/notifications',
  requireStorePermission(['project:read', 'project:write']),
  [
    query('status').optional().isIn(['unread', 'read', 'dismissed', 'resolved']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const where = { store_id: req.storeId, user_id: req.user.userId };
      if (req.query.status) where.status = req.query.status;
      const limit = req.query.limit || 50;
      const rows = await ProjectNotification.findAll({ where, order: [['created_at', 'DESC']], limit });
      return res.json({
        success: true,
        data: rows.map(r => {
          const j = r.toJSON();
          return { ...j, id: j.id_code };
        })
      });
    } catch (error) {
      console.error('List project notifications error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

router.patch(
  '/me/notifications/:id_code',
  requireStorePermission(['project:read', 'project:write']),
  [body('status').isIn(['read', 'dismissed', 'resolved'])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation error', details: errors.array() });

    try {
      const notif = await ProjectNotification.findOne({
        where: { store_id: req.storeId, user_id: req.user.userId, id_code: req.params.id_code }
      });
      if (!notif) return res.status(404).json({ error: 'Not Found', message: 'Notificação não encontrada' });
      await notif.update({ status: req.body.status });
      const j = notif.toJSON();
      return res.json({ success: true, data: { notification: { ...j, id: j.id_code } } });
    } catch (error) {
      console.error('Update project notification error:', error);
      return res.status(500).json({ error: 'Internal server error', message: 'Erro interno do servidor' });
    }
  }
);

module.exports = router;
