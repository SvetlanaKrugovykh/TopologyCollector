#!/usr/bin/env node

require('dotenv').config()
const fs = require('fs').promises
const path = require('path')
const { Telnet } = require('telnet-client')
const chalk = require('chalk')
const inquirer = require('inquirer')

// --- Huawei test with explicit username prompt, system mode, display saved-configuration, display mac-address, and space pagination ---
function needsMoreInput(output) {
  return /\s*---- More ----|\s*--More--|\s*Press SPACE to continue|\s*Press Enter to continue|\s*More:|\s*\[More\]/i.test(output)
}

async function handleMoreInput(connection) {
  let additionalOutput = ''
  let attempts = 0
  const maxAttempts = 200
  const inputChar = ' '
  while (attempts < maxAttempts) {
    try {
      const moreResult = await connection.exec(inputChar)
      additionalOutput += moreResult
      if (!needsMoreInput(moreResult)) break
      attempts++
    } catch (error) {
      break
    }
  }
  return additionalOutput
}

async function executeCommand(connection, command) {
  let result = await connection.exec(command)
  if (needsMoreInput(result)) {
    result += await handleMoreInput(connection)
  }
  return result
}

async function testHuaweiDataCollection() {
  try {
    // Prompt for password only

    const answers = await inquirer.prompt([
      { type: 'password', name: 'password', message: 'Enter device password:', mask: '*' }
    ])
    const device = {
      ip: '192.168.165.33',
      type: 'switch',
      vendor: 'Huawei',
      password: answers.password,
      requiresEnable: true,
      enableCommand: 'system',
      paginationPrompts: ["--More--", "Press any key", "continue"],
      paginationInput: ' ',
      commands: {
        config: ["display saved-configuration"],
        mac: ["display mac-address"]
      },
      description: 'Huawei switch'
    }

    console.log(chalk.cyan(`\n=== Device Information ===`))
    console.log(chalk.white(`IP Address: ${device.ip}`))
    console.log(chalk.white(`Description: ${device.description}`))
    console.log(chalk.white(`Vendor: ${device.vendor} ${device.type.toUpperCase()}`))

    const connection = new Telnet()
    try {
      console.log(chalk.yellow(`\nConnecting to ${device.ip}...`))

      const params = {
        host: device.ip,
        port: 23,
        shellPrompt: /[$%#>]/,
        timeout: 60000,
        loginPrompt: /(username|login)[: ]*$/i,
        passwordPrompt: /password[: ]*$/i,
        username: 'admin',
        password: device.password,
        execTimeout: 60000,
        debug: true
      }
      await connection.connect(params)
      console.log(chalk.green(`✓ Connected to ${device.ip}`))
      // Send empty command to clear buffer and get prompt
      try {
        await connection.exec('')
        console.log(chalk.gray('Buffer cleared, ready for commands'))
      } catch (e) {
        console.log(chalk.yellow('Buffer clear failed (ignored)'))
      }

      // Enter system mode (privileged), if required
      if (device.requiresEnable && device.enableCommand) {
        await connection.exec(device.enableCommand)
        console.log(chalk.green('✓ Entered system mode'))
      }

      // Collect configuration
      for (const command of device.commands.config) {
        try {
          console.log(chalk.cyan(`\n=== Collecting Configuration ===`))
          const result = await executeCommand(connection, command)
          if (result && result.trim().length > 0) {
            console.log(chalk.green(`✓ Command "${command}" successful`))
            console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`))
            const configDir = './configs'
            await fs.mkdir(configDir, { recursive: true })
            const filename = `${device.ip.replace(/\./g, '_')}.cfg`
            const filepath = path.join(configDir, filename)
            await fs.writeFile(filepath, result, 'utf8')
            console.log(chalk.green(`Configuration saved: ${filepath}`))
          } else {
            console.log(chalk.red(`✗ Command "${command}" returned empty result`))
          }
        } catch (error) {
          console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`))
        }
      }

      // Collect MAC table
      for (const command of device.commands.mac) {
        try {
          console.log(chalk.cyan(`\n=== Collecting MAC Table ===`))
          const result = await executeCommand(connection, command)
          if (result && result.trim().length > 0) {
            console.log(chalk.green(`✓ Command "${command}" successful`))
            console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`))
            const macDir = './mac_tables'
            await fs.mkdir(macDir, { recursive: true })
            const filename = `${device.ip.replace(/\./g, '_')}.mac`
            const filepath = path.join(macDir, filename)
            await fs.writeFile(filepath, result, 'utf8')
            console.log(chalk.green(`MAC table saved: ${filepath}`))
          } else {
            console.log(chalk.red(`✗ Command "${command}" returned empty result`))
          }
        } catch (error) {
          console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`))
        }
      }

      await connection.end()
      console.log(chalk.gray('Connection closed'))
    } catch (error) {
      console.log(chalk.red(`Connection error: ${error.message}`))
      try { await connection.end() } catch {}
    }
    console.log(chalk.green('\n✓ Data collection completed successfully'))
  } catch (error) {
    console.error(chalk.red(`\n✗ Test error: ${error.message}`))
  }
}

if (require.main === module) {
  console.log(chalk.cyan('=== Huawei Data Collection Test ===\n'))
  testHuaweiDataCollection().catch(console.error)
}
