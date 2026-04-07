const { ProjectProject, ProjectStage, ProjectTimeEntry, sequelize } = require('../models');

async function syncTotals() {
  console.log('Starting sync of project and stage totals...');
  const t = await sequelize.transaction();
  try {
    // Reset all totals first
    await ProjectProject.update({ burn_minutes: 0, burn_cost_total: 0 }, { where: {}, transaction: t });
    await ProjectStage.update({ total_minutes: 0, total_amount: 0 }, { where: {}, transaction: t });

    // Find all closed time entries
    const entries = await ProjectTimeEntry.findAll({
      where: { status: 'closed' },
      transaction: t
    });

    console.log(`Found ${entries.length} closed entries to process.`);

    for (const entry of entries) {
      if (entry.stage_id) {
        await ProjectStage.increment(
          { total_minutes: entry.minutes || 0, total_amount: entry.cost_amount_snapshot || 0 },
          { where: { id: entry.stage_id }, transaction: t }
        );
      }
      if (entry.project_id) {
        await ProjectProject.increment(
          { burn_minutes: entry.minutes || 0, burn_cost_total: entry.cost_amount_snapshot || 0 },
          { where: { id: entry.project_id }, transaction: t }
        );
      }
    }

    await t.commit();
    console.log('Sync completed successfully.');
  } catch (err) {
    await t.rollback();
    console.error('Sync failed:', err);
  }
}

syncTotals().then(() => process.exit(0));
