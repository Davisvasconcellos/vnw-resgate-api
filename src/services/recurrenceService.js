const { FinRecurrence, FinancialTransaction, sequelize } = require('../models');
const { Op } = require('sequelize');

/**
 * Calculate the next due date based on frequency and current date
 * @param {Date} currentDate 
 * @param {string} frequency 
 * @param {number} dayOfMonth 
 * @returns {Date}
 */
const calculateNextDueDate = (currentDate, frequency, dayOfMonth) => {
  // Ensure we interpret the input date string (or Date) as UTC to avoid local timezone shifts.
  // If it's a string 'YYYY-MM-DD', new Date(s) is UTC.
  // If it's a Date object, it's just a timestamp.
  const date = new Date(currentDate);

  if (frequency === 'weekly') {
    date.setUTCDate(date.getUTCDate() + 7);
  } else if (frequency === 'monthly') {
    const currentMonth = date.getUTCMonth();
    // Add 1 month
    date.setUTCMonth(currentMonth + 1);

    // Check for day overflow (e.g., Jan 31 -> Feb 28/29)
    // If dayOfMonth is provided, try to stick to it.
    if (dayOfMonth) {
      // Construct target date in UTC
      // Note: date.getUTCFullYear() and date.getUTCMonth() are already updated by setUTCMonth
      const targetYear = date.getUTCFullYear();
      const targetMonth = date.getUTCMonth();

      // Temporarily set to day 1 to avoid overflow when setting month if we were at 31
      // Actually setUTCMonth handles it by overflowing to next month if day doesn't exist.
      // So we need to check if the day changed from what we wanted.

      // We want 'dayOfMonth'.
      // If the current date.getUTCDate() is different from dayOfMonth (because of overflow),
      // or if we just want to enforce dayOfMonth.

      // Let's force the day to dayOfMonth and check validity
      const checkDate = new Date(Date.UTC(targetYear, targetMonth, dayOfMonth));

      if (checkDate.getUTCMonth() !== targetMonth) {
        // It overflowed (e.g. Feb 30 -> Mar 2), so set to last day of target month
        date.setUTCDate(0); // Sets to last day of previous month?
        // No, setUTCDate(0) sets to last day of previous month relative to the date object.
        // If we are in March (due to overflow), setUTCDate(0) goes to Feb 28.
        // Wait, let's look at logic:
        // 1. Start: Jan 31.
        // 2. setUTCMonth(+1) -> Feb 28 (non-leap) or Mar 3?
        //    JS Date behavior: Jan 31 + 1 month -> Mar 3 (if Feb has 28 days).

        // So if we are now in Mar, but we wanted Feb.
        if (date.getUTCMonth() !== (currentMonth + 1) % 12) {
          // We overshot. Backtrack to last day of the intended month.
          date.setUTCDate(0);
        }
      } else {
        date.setUTCDate(dayOfMonth);
      }
    } else {
      // No specific dayOfMonth, just maintain the day we had.
      // If we had Jan 31 and now we are Mar 3 (default JS behavior), we want Feb 28.
      if (date.getUTCMonth() !== (currentMonth + 1) % 12) {
        date.setUTCDate(0);
      }
    }
  } else if (frequency === 'yearly') {
    date.setUTCFullYear(date.getUTCFullYear() + 1);
  }

  // Return YYYY-MM-DD string to avoid Sequelize timezone shifts with DATEONLY
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

const normalizeDueDate = (nextDueDate, frequency, dayOfMonth) => {
  if (!nextDueDate) return nextDueDate;
  if (frequency !== 'monthly') return String(nextDueDate).slice(0, 10);

  const base = new Date(`${String(nextDueDate).slice(0, 10)}T00:00:00Z`);
  const baseYear = base.getUTCFullYear();
  const baseMonth = base.getUTCMonth();
  const baseDay = base.getUTCDate();
  const targetDay = Math.max(1, Math.min(parseInt(dayOfMonth, 10) || 1, 31));
  const daysThisMonth = new Date(Date.UTC(baseYear, baseMonth + 1, 0)).getUTCDate();
  const dayThisMonth = Math.min(targetDay, daysThisMonth);
  let candidate = new Date(Date.UTC(baseYear, baseMonth, dayThisMonth));

  if (candidate.getUTCDate() < baseDay) {
    const nextMonth = new Date(Date.UTC(baseYear, baseMonth + 1, 1));
    const ny = nextMonth.getUTCFullYear();
    const nm = nextMonth.getUTCMonth();
    const daysNextMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    const dayNextMonth = Math.min(targetDay, daysNextMonth);
    candidate = new Date(Date.UTC(ny, nm, dayNextMonth));
  }

  const y = candidate.getUTCFullYear();
  const m = String(candidate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(candidate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const generatePendingTransactions = async (targetDateInput = new Date(), storeId = null) => {
  const t = await sequelize.transaction();

  try {
    // Let's format targetDate to YYYY-MM-DD string for safer comparison with DATEONLY
    const d = new Date(targetDateInput);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const targetDateStr = `${year}-${month}-${day}`;

    // Find active recurrences due on or before targetDate
    const where = {
      status: 'active',
      next_due_date: {
        [Op.lte]: targetDateStr
      },
      [Op.or]: [
        { end_date: null },
        { end_date: { [Op.gte]: targetDateStr } }
      ]
    };

    if (storeId) {
      where.store_id = storeId;
    }

    const dueRecurrences = await FinRecurrence.findAll({
      where,
      transaction: t
    });

    const results = {
      processed: 0,
      generated: 0,
      skipped: 0,
      errors: 0,
      details: []
    };

    for (const recurrence of dueRecurrences) {
      try {
        const dueDateForTxn = normalizeDueDate(
          recurrence.next_due_date,
          recurrence.frequency,
          recurrence.day_of_month
        );

        const existingTxn = await FinancialTransaction.findOne({
          where: {
            store_id: recurrence.store_id,
            recurrence_id: recurrence.id_code,
            due_date: dueDateForTxn
          },
          transaction: t
        });

        if (!existingTxn) {
          await FinancialTransaction.create({
            store_id: recurrence.store_id,
            type: recurrence.type,
            description: recurrence.description,
            amount: recurrence.amount,
            due_date: dueDateForTxn,
            status: 'provisioned',
            recurrence_id: recurrence.id_code,
            party_id: recurrence.party_id,
            category_id: recurrence.category_id,
            cost_center_id: recurrence.cost_center_id,
            created_by_user_id: recurrence.created_by_user_id,
            is_paid: false
          }, { transaction: t });
        }

        // Update Recurrence next_due_date
        const nextDate = calculateNextDueDate(
          dueDateForTxn,
          recurrence.frequency,
          recurrence.day_of_month
        );

        recurrence.next_due_date = nextDate;

        // Check if passed end_date
        if (recurrence.end_date && nextDate > new Date(recurrence.end_date)) {
          recurrence.status = 'finished';
        }

        await recurrence.save({ transaction: t });

        results.processed++;
        if (existingTxn) {
          results.skipped++;
          results.details.push({ id: recurrence.id_code, status: 'skipped', next_date: nextDate });
        } else {
          results.generated++;
          results.details.push({ id: recurrence.id_code, status: 'success', next_date: nextDate });
        }
      } catch (err) {
        console.error(`Error processing recurrence ${recurrence.id_code}:`, err);
        results.processed++;
        results.errors++;
        results.details.push({ id: recurrence.id_code, status: 'error', error: err.message });
      }
    }

    await t.commit();
    return results;

  } catch (error) {
    await t.rollback();
    throw error;
  }
};

module.exports = {
  generatePendingTransactions
};
