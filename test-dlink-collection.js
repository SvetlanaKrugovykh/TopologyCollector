#!/usr/bin/env node

require('dotenv').config()
const fs = require('fs').promises
const path = require('path')
const { Telnet } = require('telnet-client')
const chalk = require('chalk')
const inquirer = require('inquirer')

// Functions for handling pagination
function needsMoreInput(output, device) {
  // D-Link specific patterns - look for key words
  const dlinkPatterns = [
    /Quit.*SPACE.*Next.*Page/i,
    /SPACE.*n.*Next.*Page/i,
    /ENTER.*Next.*Entry.*a.*All/i,
    /a All/i
  ]

  // Use device-specific pagination prompts if available
  const prompts = device.paginationPrompts || [
    /CTRL\+C ESC q Quit SPACE n Next Page ENTER Next Entry a All/i,
    /q Quit SPACE n Next Page ENTER Next Entry a All/i,
    /--More--/i,
    /Press any key to continue/i,
    /Press SPACE to continue/i,
    /Press Enter to continue/i,
    /\[Press 'A' for All or ENTER to continue\]/i,
    /Type <CR> to continue/i
  ]

  // Combine D-Link patterns with generic ones
  const allPatterns = [...dlinkPatterns, ...prompts]

  // Convert string prompts to regex
  const patterns = allPatterns.map(prompt => {
    if (typeof prompt === 'string') {
      return new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    return prompt
  })

  const hasMore = patterns.some(pattern => pattern.test(output))

  if (hasMore) {
    console.log(chalk.blue(`DEBUG: Pagination detected with D-Link pattern in: "${output.slice(-150)}"`))
  }

  return hasMore
}

async function handleMoreInput(connection, device) {
  let additionalOutput = ''
  let attempts = 0
  const maxAttempts = 200
  const inputChar = device.paginationInput || 'a'

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
  console.log(chalk.yellow(`\nExecuting command with shell(): ${command}`))

  return new Promise((resolve, reject) => {
    let fullResult = ''
    let isComplete = false
    let commandTimeout

    connection.shell((error, stream) => {
      if (error) {
        reject(error)
        return
      }

      console.log(chalk.gray('Started shell session'))

      // Set a timeout to prevent hanging
      commandTimeout = setTimeout(() => {
        if (!isComplete) {
          console.log(chalk.yellow('Command timeout - forcing completion'))
          isComplete = true
          stream.destroy()
        }
      }, 30000); // 30 second timeout

      // Send command immediately without waiting for prompt
      setTimeout(() => {
        console.log(chalk.gray(`Sending command immediately: ${command}`))
        stream.write(command + '\r\n')
      }, 500); // Small delay to establish session

      stream.on('data', (data) => {
        const output = data.toString()
        fullResult += output

        console.log(chalk.blue(`Received: "${output}"`))

        // Check for D-Link pagination patterns
        if (needsMoreInput(output, device)) {
          console.log(chalk.cyan('Pagination detected - sending "a"...'))
          stream.write('a')
        }
        // Check if command is complete (ends with prompt)
        else if (output.match(/[$%#>]\s*$/) && fullResult.length > command.length + 10) {
          if (!isComplete) {
            console.log(chalk.green('Command completed - prompt detected'))
            isComplete = true
            // Force close the stream with a timeout
            setTimeout(() => {
              stream.destroy()
            }, 100)
          }
        }
      })

      stream.on('close', () => {
        console.log(chalk.gray('Shell session closed'))

        // Clear timeout
        if (commandTimeout) {
          clearTimeout(commandTimeout)
        }

        if (!isComplete) {
          console.log(chalk.yellow('Session closed without completion detection'))
        }

        // Clean the result - remove prompts and command echo
        let cleanResult = fullResult

        // Remove everything before the command
        const commandIndex = cleanResult.indexOf(command)
        if (commandIndex !== -1) {
          cleanResult = cleanResult.substring(commandIndex + command.length)
        }

        // Remove trailing prompt
        cleanResult = cleanResult.replace(/DGS-\d+-\d+SC:[a-zA-Z]+[#$>]\s*$/, '')
        cleanResult = cleanResult.replace(/[#$>]\s*$/, '')
        cleanResult = cleanResult.trim()

        console.log(chalk.green(`✓ Command result length: ${cleanResult.length} chars`))

        if (cleanResult.length > 0) {
          resolve(cleanResult)
        } else {
          reject(new Error('No command output received'))
        }
      })

      stream.on('error', (err) => {
        console.log(chalk.red(`Shell error: ${err.message}`))

        // Clear timeout
        if (commandTimeout) {
          clearTimeout(commandTimeout)
        }

        reject(err)
      })

      // Set timeout
      setTimeout(() => {
        if (!isComplete) {
          console.log(chalk.yellow('Command timeout - forcing completion'))
          stream.end()
        }
      }, 15000); // Reduced timeout
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
      timeout: 15000,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.username,
      password: password,
      execTimeout: 5000,
      debug: false
    }

    await connection.connect(params)
    console.log(chalk.green(`✓ Connected to ${device.ip}`))

    // Small delay to ensure connection is stable
    await new Promise(resolve => setTimeout(resolve, 500))

    // Enter privileged mode if required
    if (device.requiresEnable && device.enableCommand) {
      console.log(chalk.gray(`Entering privileged mode...`))
      await connection.exec(device.enableCommand)
      console.log(chalk.green('✓ Entered privileged mode'))
    }

    // Execute the command
    console.log(chalk.gray(`Executing command: ${command}`))
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

async function testDLinkDataCollection() {
  try {
    // Device configuration for D-Link switch
    const device = {
      ip: "192.168.65.244",
      type: "switch",
      vendor: "D-Link",
      username: "admin",
      password: null,
      enableCommand: "enable", // D-Link may require enable
      requiresEnable: false, // DISABLED for simple connection
      paginationPrompts: [
        "q Quit SPACE n Next Page ENTER Next Entry a All",
        "CTRL+C ESC q Quit SPACE n Next Page ENTER Next Entry a All"
      ],
      paginationInput: "a", // D-Link expects 'a' to show all
      commands: {
        config: ["show config effective"],
        mac: ["show fdb"]
      },
      description: "D-Link_Switch - Test Collection"
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
            mask: '*',
            maskSymbol: '*'
          }
        ])

        password = answers.password

        // Show password feedback
        if (password && password.length > 0) {
          console.log(chalk.green(`✓ Password entered (${password.length} characters)`))
        } else {
          console.log(chalk.red(`✗ No password entered`))
          continue; // Try again
        }

        break; // Password entered, proceed

      } catch (error) {
        console.log(chalk.red(`✗ Error getting password: ${error.message}`))

        if (attempt === maxPasswordAttempts) {
          throw new Error(`Failed to get password after ${maxPasswordAttempts} attempts`)
        } else {
          console.log(chalk.yellow(`Please try again...`))
        }
      }
    }

    console.log(chalk.cyan(`\n=== Starting data collection from ${device.ip} (${device.description}) ===`))

    // Use ONE connection for ALL commands - like in working version
    const connection = new Telnet()

    try {
      console.log(chalk.yellow(`\nConnecting to ${device.ip}...`))

      const params = {
        host: device.ip,
        port: 23,
        shellPrompt: /[$%#>]/,
        timeout: 45000, // Very long timeout
        loginPrompt: /(username|login)[: ]*$/i,
        passwordPrompt: /password[: ]*$/i,
        username: device.username,
        password: password,
        execTimeout: 45000, // Very long exec timeout
        debug: false
      }

      await connection.connect(params)
      console.log(chalk.green(`✓ Connected to ${device.ip}`))

      // Clear any initial output and wait for prompt
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Send empty command to clear buffer and get clean prompt
      try {
        await connection.exec('')
        console.log(chalk.gray('Buffer cleared'))
      } catch (e) {
        // Ignore errors from empty command
      }

      // Small delay
      await new Promise(resolve => setTimeout(resolve, 500))

      // Execute config command
      console.log(chalk.cyan('\n=== Collecting Configuration ==='))
      for (const command of device.commands.config) {
        try {
          const result = await executeCommand(connection, command, device)

          if (result && result.trim().length > 0) {
            console.log(chalk.green(`✓ Command "${command}" successful`))
            console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`))

            // Save configuration
            const configDir = './configs'
            await fs.mkdir(configDir, { recursive: true })
            const filename = `${device.ip.replace(/\./g, '_')}.cfg`
            const filepath = path.join(configDir, filename)

            try {
              await fs.access(filepath)
              console.log(chalk.yellow(`Overwriting existing file: ${filepath}`))
            } catch {
              console.log(chalk.gray(`Creating new file: ${filepath}`))
            }

            await fs.writeFile(filepath, result, 'utf8')
            console.log(chalk.green(`Configuration saved: ${filepath}`))
            break
          } else {
            console.log(chalk.red(`✗ Command "${command}" returned empty result`))
          }
        } catch (error) {
          console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`))
        }
      }

      // Small delay between commands
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Execute MAC command on SAME connection
      console.log(chalk.cyan('\n=== Collecting FDB Table ==='))
      for (const command of device.commands.mac) {
        try {
          const result = await executeCommand(connection, command, device)

          if (result && result.trim().length > 0) {
            console.log(chalk.green(`✓ Command "${command}" successful`))
            console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`))

            // Save FDB table
            const macDir = './mac_tables'
            await fs.mkdir(macDir, { recursive: true })
            const filename = `${device.ip.replace(/\./g, '_')}.mac`
            const filepath = path.join(macDir, filename)

            try {
              await fs.access(filepath)
              console.log(chalk.yellow(`Overwriting existing file: ${filepath}`))
            } catch {
              console.log(chalk.gray(`Creating new file: ${filepath}`))
            }

            await fs.writeFile(filepath, result, 'utf8')
            console.log(chalk.green(`FDB table saved: ${filepath}`))
            break
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
      try {
        await connection.end()
      } catch (e) {
        // Ignore connection close errors
      }
    }

    console.log(chalk.green('\n✓ Data collection completed successfully'))

  } catch (error) {
    console.error(chalk.red(`\n✗ Test error: ${error.message}`))
  }
}

if (require.main === module) {
  console.log(chalk.cyan('=== D-Link Data Collection Test ===\n'))
  testDLinkDataCollection().catch(console.error)
}
