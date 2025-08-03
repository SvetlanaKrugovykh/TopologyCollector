#!/usr/bin/env node

// Simple test script to verify the integration works
require('dotenv').config();
const TopologyCollector = require('./index.js');
const chalk = require('chalk');

async function testIntegration() {
  try {
    // Test with DLinks.json file
    process.env.DEVICES_FILE = 'DLinks.json';
    
    console.log(chalk.blue('=== Testing integrated D-Link collection ===\n'));
    
    const collector = new TopologyCollector();
    await collector.init();
    
    // Ask for password
    await collector.askForPassword();
    
    console.log(chalk.yellow('\n=== Testing config collection ==='));
    await collector.collectConfigs();
    
    console.log(chalk.yellow('\n=== Testing MAC table collection ==='));
    await collector.collectMacTables();
    
    console.log(chalk.green('\n✓ Integration test completed successfully!'));
    
  } catch (error) {
    console.error(chalk.red(`\n✗ Integration test failed: ${error.message}`));
    console.error(error.stack);
  }
}

if (require.main === module) {
  testIntegration();
}
