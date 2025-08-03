#!/usr/bin/env node

// Simple test script to verify the integration works
// Load .env before importing index.js
require('dotenv').config()

const TopologyCollector = require('./index.js')
const chalk = require('chalk')

async function testIntegration() {
  try {
    // Use DEVICES_FILE from .env file
    console.log(chalk.blue(`=== Testing integrated collection with ${process.env.DEVICES_FILE || 'default devices file'} ===\n`))
    
    const collector = new TopologyCollector()
    await collector.init()
    
    console.log(chalk.yellow('\n=== Testing complete collection (configs + MAC tables) ==='))
    await collector.collectAll()
    
    console.log(chalk.green('\n✓ Integration test completed successfully!'))
    
  } catch (error) {
    console.error(chalk.red(`\n✗ Integration test failed: ${error.message}`))
    console.error(error.stack)
  }
}

if (require.main === module) {
  testIntegration()
}
