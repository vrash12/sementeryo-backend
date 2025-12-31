// backend/database/init_database.js
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

async function initializeDatabase() {
  try {
    console.log('🗄️ Initializing Cemetery Database...');
    
    // Read and execute the schema
    const schemaSQL = fs.readFileSync(
      path.join(__dirname, 'improved_schema.sql'), 
      'utf8'
    );
    
    await pool.query(schemaSQL);
    console.log('✅ Database schema created successfully');
    
    // Test PostGIS functionality
    const testResult = await pool.query('SELECT PostGIS_Version() as version');
    console.log('✅ PostGIS version:', testResult.rows[0].version);
    
    // Test cemetery bounds function
    const boundsResult = await pool.query('SELECT * FROM get_cemetery_bounds()');
    console.log('✅ Cemetery bounds:', boundsResult.rows[0]);
    
    // Count plots
    const plotCount = await pool.query('SELECT COUNT(*) as total FROM plots');
    console.log('✅ Total plots inserted:', plotCount.rows[0].total);
    
    console.log('🎉 Cemetery database initialization complete!');
    
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  } finally {
    await pool.end();
  }
}

initializeDatabase();