const pool = require('../config/database')

async function getCemeteryInfo(req, res, next) {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, address, slogan, description, logo_url, created_at, updated_at
         FROM cemetery_info WHERE id = 1`
      );
      if (!rows.length) return res.json({ success: true, data: null });
      res.json({ success: true, data: rows[0] });
    } catch (err) { next(err); }
  }
  
  module.exports = { getCemeteryInfo };