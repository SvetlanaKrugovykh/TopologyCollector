#!/usr/bin/env node

require('dotenv').config()
const fs = require('fs').promises
const path = require('path')
const { Telnet } = require('telnet-client')
const chalk = require('chalk')
const inquirer = require('inquirer')

// Functions for handling pagination
function needsMoreInput(output, device) {
  // Use device-specific pagination prompts if available
  const prompts = device.paginationPrompts || [
    /--More--/i,
    /Press any key to continue/i,
    /Press SPACE to continue/i,
    /Press Enter to continue/i,
    /\[Press 'A' for All or ENTER to continue\]/i,
    /Type <CR> to continue/i
  ]

  // Convert string prompts to regex
  const patterns = prompts.map(prompt => {
    if (typeof prompt === 'string') {
      return new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    return prompt
  })

  const hasMore = patterns.some(pattern => pattern.test(output))

  if (hasMore) {
    console.log(chalk.blue(`DEBUG: Pagination detected with BDCOM pattern`))
  }

  return hasMore
} async function handleMoreInput(connection, device) {
  let additionalOutput = ''
  let attempts = 0
  const maxAttempts = 200
  const inputChar = device.paginationInput || ' '

  console.log(chalk.cyan(`  Starting pagination handling with input: "${inputChar}"`))

  while (attempts < maxAttempts) {
    try {
      console.log(chalk.gray(`    Sending "${inputChar}" to continue... (${attempts + 1}/${maxAttempts})`))
      const moreResult = await connection.exec(inputChar)
      additionalOutput += moreResult

      // Show last part of current result
      console.log(chalk.blue(`    Last 100 chars: "${moreResult.slice(-100)}"`))

      // Check if we need to continue
      if (!needsMoreInput(moreResult, device)) {
        console.log(chalk.green(`  ✓ Pagination completed after ${attempts + 1} attempts`))
        break
      }

      attempts++

    } catch (error) {
      console.log(chalk.red(`  Error handling more input: ${error.message}`))
      break
    }
  }

  if (attempts >= maxAttempts) {
    console.log(chalk.yellow(`  Maximum attempts (${maxAttempts}) reached for pagination`))
  }

  return additionalOutput
}

async function executeCommand(connection, command, device) {
  return new Promise((resolve, reject) => {
    console.log(chalk.yellow(`\nTrying command: ${command}`))

    let fullResult = ''
    let isComplete = false

    // Use shell() method for raw interaction
    connection.shell((error, stream) => {
      if (error) {
        reject(error)
        return
      }

      console.log(chalk.gray('Started shell session for command execution'))

      // Set up data handler
      stream.on('data', (data) => {
        const output = data.toString()
        fullResult += output

        console.log(chalk.blue(`Received data (${output.length} chars): "${output.slice(-100)}"`))

        // Check if we need to handle pagination
        if (needsMoreInput(output, device)) {
          console.log(chalk.cyan('Pagination detected - sending space...'))
          stream.write(device.paginationInput || ' ')
        }
        // Check if command is complete (ends with prompt)
        else if (output.match(/[$%#>]\s*$/)) {
          console.log(chalk.green('Command completed - prompt detected'))
          isComplete = true

          // Immediately resolve with result before ending stream
          resolve(fullResult)

          // Then end the stream
          setTimeout(() => {
            stream.end()
          }, 100)
        }
      })

      stream.on('close', () => {
        console.log(chalk.gray('Shell session closed'))
        if (isComplete) {
          console.log(chalk.green(`✓ Command completed, result length: ${fullResult.length}`))
          resolve(fullResult)
        } else {
          reject(new Error('Command did not complete properly'))
        }
      })

      stream.on('error', (err) => {
        console.log(chalk.red(`Shell error: ${err.message}`))
        reject(err)
      })

      // Send the command
      console.log(chalk.gray(`Sending command: ${command}`))
      stream.write(command + '\r\n')

      // Set timeout for safety
      setTimeout(() => {
        if (!isComplete) {
          console.log(chalk.yellow('Command timeout - forcing completion'))
          stream.end()
          if (fullResult.length > 0) {
            resolve(fullResult)
          } else {
            reject(new Error('Command timeout with no result'))
          }
        }
      }, 120000); // 2 minutes timeout
    })
  })
}

async function connectAndExecuteCommand(device, password, command, commandType) {
  const connection = new Telnet()

  try {
    console.log(chalk.yellow(`\nConnecting to ${device.ip} for ${commandType} command...`))

    const params = {
      host: device.ip,
      port: 23,
      shellPrompt: /[$%#>]/,
      timeout: 30000,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.username,
      password: password,
      execTimeout: 15000,
      debug: false
    }

    // Add source IP if specified in environment
    if (process.env.TELNET_SOURCE_IP) {
      params.localAddress = process.env.TELNET_SOURCE_IP
      console.log(chalk.blue(`Using source IP: ${process.env.TELNET_SOURCE_IP}`))
    }

    await connection.connect(params)
    console.log(chalk.green(`✓ Connected to ${device.ip}`))

    // Enter privileged mode if required
    if (device.requiresEnable && device.enableCommand) {
      console.log(chalk.gray(`Entering privileged mode...`))
      await connection.exec(device.enableCommand)
      console.log(chalk.green('✓ Entered privileged mode'))
    }

    // Execute the command
    const result = await executeCommand(connection, command, device)

    await connection.end()
    console.log(chalk.gray(`Connection closed for ${commandType} command`))

    return result

  } catch (error) {
    console.log(chalk.red(`Error in ${commandType} command execution: ${error.message}`))
    try {
      await connection.end()
    } catch (e) {
      // Ignore connection close errors
    }
    throw error
  }
}
async function testDataCollection() {
  try {
    // Device configuration
    const device = {
      ip: process.env.TEST_DEVICE_IP || "192.168.1.102",
      type: "olt",
      vendor: "BDCOM",
      username: "admin",
      password: null,
      enableCommand: "enable",
      requiresEnable: true,
      paginationPrompts: ["--More--"],
      paginationInput: " ",
      commands: {
        config: ["show running-config"],
        mac: ["show mac address-table"]
      },
      description: "OLT_Tatsenky"
    }

    console.log(chalk.cyan(`\n=== Device Information ===`))
    console.log(chalk.white(`IP Address: ${device.ip}`))
    console.log(chalk.white(`Description: ${device.description}`))
    console.log(chalk.white(`Vendor: ${device.vendor} ${device.type.toUpperCase()}`))
    console.log(chalk.white(`Username: ${device.username}`))

    // Get password with multiple attempts
    let password = null
    const maxPasswordAttempts = 3

    for (let attempt = 1; attempt <= maxPasswordAttempts; attempt++) {
      try {
        const answers = await inquirer.prompt([
          {
            type: 'password',
            name: 'password',
            message: attempt === 1
              ? 'Enter device password:'
              : `Enter device password (attempt ${attempt}/${maxPasswordAttempts}):`,
            mask: '*'
          }
        ])

        password = answers.password

        // Quick test connection to validate password
        console.log(chalk.gray(`Testing connection with provided password...`))
        const testConnection = new Telnet()
        const testParams = {
          host: device.ip,
          port: 23,
          shellPrompt: /[$%#>]/,
          timeout: 15000,
          loginPrompt: /(username|login)[: ]*$/i,
          passwordPrompt: /password[: ]*$/i,
          username: device.username,
          password: password,
          execTimeout: 5000,
          debug: false
        }

        // Add source IP if specified in environment
        if (process.env.TELNET_SOURCE_IP) {
          testParams.localAddress = process.env.TELNET_SOURCE_IP
        }

        await testConnection.connect(testParams)
        await testConnection.end()
        console.log(chalk.green(`✓ Password validated successfully`))
        break; // Password is correct, exit loop

      } catch (error) {
        console.log(chalk.red(`✗ Connection failed: ${error.message}`))

        if (attempt === maxPasswordAttempts) {
          throw new Error(`Failed to authenticate after ${maxPasswordAttempts} attempts`)
        } else {
          console.log(chalk.yellow(`Please try again...`))
        }
      }
    }

    console.log(chalk.cyan(`\n=== Starting data collection from ${device.ip} (${device.description}) ===`))

    // Test config commands with separate connection
    console.log(chalk.cyan('\n=== Collecting Configuration ==='))
    for (const command of device.commands.config) {
      try {
        const result = await connectAndExecuteCommand(device, password, command, 'CONFIG')

        if (result && result.trim().length > 0) {
          console.log(chalk.green(`✓ Command "${command}" successful`))
          console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`))

          // Save configuration
          const configDir = './configs'
          await fs.mkdir(configDir, { recursive: true })
          const filename = `${device.ip.replace(/\./g, '_')}.cfg`
          const filepath = path.join(configDir, filename)

          // Check if file exists and log accordingly
          try {
            await fs.access(filepath)
            console.log(chalk.yellow(`Overwriting existing file: ${filepath}`))
          } catch {
            console.log(chalk.gray(`Creating new file: ${filepath}`))
          }

          await fs.writeFile(filepath, result, 'utf8')
          console.log(chalk.green(`Configuration saved: ${filepath}`))
          break; // Use first working command
        } else {
          console.log(chalk.red(`✗ Command "${command}" returned empty result`))
        }
      } catch (error) {
        console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`))
      }
    }

    // Test MAC commands with separate connection
    console.log(chalk.cyan('\n=== Collecting MAC Table ==='))
    for (const command of device.commands.mac) {
      try {
        const result = await connectAndExecuteCommand(device, password, command, 'MAC')

        if (result && result.trim().length > 0) {
          console.log(chalk.green(`✓ Command "${command}" successful`))
          console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`))

          // Save MAC table
          const macDir = './mac_tables'
          await fs.mkdir(macDir, { recursive: true })
          const filename = `${device.ip.replace(/\./g, '_')}.mac`
          const filepath = path.join(macDir, filename)

          // Check if file exists and log accordingly
          try {
            await fs.access(filepath)
            console.log(chalk.yellow(`Overwriting existing file: ${filepath}`))
          } catch {
            console.log(chalk.gray(`Creating new file: ${filepath}`))
          }

          await fs.writeFile(filepath, result, 'utf8')
          console.log(chalk.green(`MAC table saved: ${filepath}`))
          break; // Use first working command
        } else {
          console.log(chalk.red(`✗ Command "${command}" returned empty result`))
        }
      } catch (error) {
        console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`))
      }
    }

    console.log(chalk.green('\n✓ Data collection completed successfully'))

  } catch (error) {
    console.error(chalk.red(`\n✗ Test error: ${error.message}`))
  }
}

if (require.main === module) {
  console.log(chalk.cyan('=== Data Collection Test ===\n'))
  testDataCollection().catch(console.error)
}
