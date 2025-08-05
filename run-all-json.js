#!/usr/bin/env node

require('dotenv').config()
const fs = require('fs').promises
const path = require('path')
const chalk = require('chalk')
const TopologyCollector = require('./index.js')

async function runForAllJsonFiles() {
  const dataDir = process.env.DATA_DIR || './data'
  let files
  try {
    files = await fs.readdir(dataDir)
  } catch (err) {
    console.error(chalk.red(`Failed to read data directory: ${err.message}`))
    process.exit(1)
  }

  // Filter all .json except brandSettings.json
  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'brandSettings.json')
  if (jsonFiles.length === 0) {
    console.log(chalk.yellow('No device JSON files found in data directory.'))
    return
  }

  for (const file of jsonFiles) {
    const absPath = path.join(dataDir, file)
    console.log(chalk.blue(`\n=== Running collection for ${file} ===`))
    try {
      // Set devices file for this run
      const collector = new TopologyCollector()
      collector.devicesFile = absPath
      await collector.init()
      await collector.collectAll()
      console.log(chalk.green(`\n✓ Collection completed for ${file}`))
    } catch (err) {
      console.error(chalk.red(`\n✗ Collection failed for ${file}: ${err.message}`))
    }
  }
  console.log(chalk.cyan('\nAll device JSON files processed.'))
}

if (require.main === module) {
  runForAllJsonFiles()
}
