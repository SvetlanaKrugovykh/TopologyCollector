#!/usr/bin/env node

require('dotenv').config()
const fs = require('fs').promises
const path = require('path')
const { Telnet } = require('telnet-client')
const chalk = require('chalk')
const inquirer = require('inquirer')
const winston = require('winston')

// Logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: process.env.LOG_FILE || './logs/collector.log'
    })
  ]
})

class NetworkDeviceCollector {
  constructor(devicesFileOverride = null) {
    this.devices = []
    this.brandSettings = {}
    this.globalPassword = null
    this.configsDir = process.env.CONFIGS_DIR || './configs'
    this.macTablesDir = process.env.MAC_TABLES_DIR || './mac_tables'
    this.logsDir = process.env.LOGS_DIR || './logs'

    // Build full path to devices file
    const dataDir = process.env.DATA_DIR || './data'
    let devicesFileName = process.env.DEVICES_FILE || 'devices.json'
    if (devicesFileOverride) {
      devicesFileName = devicesFileOverride
    }
    this.devicesFile = path.join(dataDir, devicesFileName)
    this.brandSettingsFile = path.join(dataDir, 'brandSettings.json')
  }

  async init() {
    try {
      // Create necessary directories
      await this.ensureDirectories()

      // Load brand settings
      await this.loadBrandSettings()

      // Load device list
      await this.loadDevices()

      // Ask user for password (after loading devices so we can show context)
      await this.askForPassword()

      logger.info('Initialization completed successfully')
    } catch (error) {
      logger.error(`Initialization error: ${error.message}`)
      throw error
    }
  }

  async ensureDirectories() {
    const dirs = [this.configsDir, this.macTablesDir, this.logsDir]
    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true })
        logger.debug(`Directory created: ${dir}`)
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error
        }
      }
    }
  }

  async loadBrandSettings() {
    try {
      const data = await fs.readFile(this.brandSettingsFile, 'utf8')
      this.brandSettings = JSON.parse(data)
      logger.info(`Loaded brand settings for: ${Object.keys(this.brandSettings).join(', ')}`)
      logger.debug(`Full brand settings:`, this.brandSettings)
    } catch (error) {
      logger.warn(`Error loading brand settings file: ${error.message}`)
      logger.info('Using default brand settings')
      this.brandSettings = {
        'D-Link': { connectionMethod: 'shell', paginationInput: 'a' },
        'Huawei': { connectionMethod: 'exec', paginationInput: ' ' },
        'Cisco': { connectionMethod: 'exec', paginationInput: ' ' }
      }
    }
  }

  async loadDevices() {
    try {
      const data = await fs.readFile(this.devicesFile, 'utf8')
      this.devices = JSON.parse(data)
      logger.info(`Loaded ${this.devices.length} devices`)
    } catch (error) {
      logger.error(`Error loading devices file: ${error.message}`)
      throw error
    }
  }

  async askForPassword() {
    // Show context information if available
    const deviceFileName = path.basename(this.devicesFile)
    let promptMessage = 'Enter administrator password for devices:'

    if (deviceFileName && deviceFileName !== 'devices.json') {
      promptMessage = `Enter administrator password for devices in ${deviceFileName}:`
    }

    // Show first device info if available
    if (this.devices && this.devices.length > 0) {
      const firstDevice = this.devices[0]
      console.log(chalk.yellow(`\nDevice file: ${deviceFileName}`))
      console.log(chalk.yellow(`First device: ${firstDevice.ip} - ${firstDevice.description || firstDevice.name || 'No description'}`))
      console.log(chalk.yellow(`Total devices: ${this.devices.length}`))
    }

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: promptMessage,
        mask: '*'
      }
    ])
    this.globalPassword = answers.password
  }

  getDeviceSettings(device) {
    // 1. If device.connectionSettings exists, use it fully
    if (device.connectionSettings) {
      return device.connectionSettings
    }

    // 2. Get brand settings (brandSettings) as base
    // If device.brand is missing, use device.vendor
    const brand = device.brand || device.vendor
    let base = this.brandSettings[brand] ? { ...this.brandSettings[brand] } : {
      connectionMethod: 'exec',
      paginationMethod: 'exec',
      timeout: 30000,
      shellPrompt: '/[$%#>]/',
      requiresEnable: false,
      paginationInput: ' ',
      commandTimeout: 10000,
      execTimeout: 30000
    }

    // 3. If timeouts are explicitly set in device, they take priority
    for (const key of ['timeout', 'commandTimeout', 'execTimeout', 'shellTimeout']) {
      if (device[key] !== undefined && device[key] !== null) {
        base[key] = device[key]
      }
    }

    logger.debug(`Device settings for ${device.ip}:`, base)
    return base
  }

  async connectToDevice(device) {
    const connection = new Telnet()

    // Get connection settings from brand settings or device config
    const settings = this.getDeviceSettings(device)
    const timeout = settings.timeout || parseInt(process.env.TELNET_TIMEOUT) || 30000
    const execTimeout = settings.execTimeout || parseInt(process.env.COMMAND_TIMEOUT) || 10000

    // D-Link: Force cleanup of existing connections
    if (device.brand?.toLowerCase() === 'd-link') {
      logger.debug(`D-Link device detected: ${device.ip} - forcing cleanup before connection`)
    }

    // Use shellPrompt from settings if present, else default
    let shellPrompt = /[$%#>]/
    if (settings.shellPrompt) {
      try {
        // If shellPrompt is a string like '/.../', convert to RegExp
        if (typeof settings.shellPrompt === 'string' && settings.shellPrompt.startsWith('/')) {
          const match = settings.shellPrompt.match(/^\/(.*)\/(.*)$/)
          if (match) {
            shellPrompt = new RegExp(match[1], match[2] || '')
          }
        } else if (settings.shellPrompt instanceof RegExp) {
          shellPrompt = settings.shellPrompt
        }
      } catch { }
    }

    // Password: use global password
    let usedPassword = this.globalPassword
    // Debug log (mask password)
    logger.debug(`Password for ${device.ip}: ${usedPassword ? usedPassword.replace(/./g, '*') : '[empty]'}`)

    const params = {
      host: device.ip,
      port: 23,
      shellPrompt: shellPrompt,
      timeout: timeout,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.credentials?.username || device.username || 'admin',
      password: usedPassword,
      execTimeout: execTimeout,
      debug: false
    }

    // Add source IP if specified in environment
    if (process.env.TELNET_SOURCE_IP) {
      params.localAddress = process.env.TELNET_SOURCE_IP
      logger.debug(`Using source IP: ${process.env.TELNET_SOURCE_IP} for connection to ${device.ip}`)
    }

    try {
      logger.info(`Connecting to device ${device.ip} (${device.name || device.description})`)
      logger.debug(`Connection params: host=${device.ip}, timeout=${timeout}, execTimeout=${execTimeout}`)

      // D-Link: try to clear possible hanging connections first
      if (device.brand?.toLowerCase() === 'd-link') {
        logger.debug(`D-Link connection attempt to ${device.ip}`)
      }

      await connection.connect(params)
      logger.info(`Successfully connected to ${device.ip}`)

      // Enter privileged mode if required
      logger.debug(`Checking enable requirements for ${device.ip}: settings.requiresEnable=${settings.requiresEnable}, device.requiresEnable=${device.requiresEnable}, device.enableCommand=${device.enableCommand}`)

      if ((settings.requiresEnable || device.requiresEnable) && device.enableCommand) {
        try {
          console.log(chalk.cyan(`✓ Enable condition met for ${device.ip} - sending command: ${device.enableCommand}`))
          logger.info(`Entering privileged mode on ${device.ip} with command: ${device.enableCommand}`)
          await connection.exec(device.enableCommand)
          console.log(chalk.green(`✓ Successfully entered privileged mode on ${device.ip}`))
          logger.info(`Successfully entered privileged mode on ${device.ip}`)
        } catch (error) {
          console.log(chalk.red(`✗ Failed to enter privileged mode on ${device.ip}: ${error.message}`))
          logger.warn(`Failed to enter privileged mode on ${device.ip}: ${error.message}`)
        }
      } else {
        console.log(chalk.gray(`- No enable command needed for ${device.ip}`))
      }

      return connection
    } catch (error) {
      logger.error(`Connection error to ${device.ip}: ${error.message}`)
      throw error
    }
  }

  async connectToDeviceWithPassword(device, password) {
    const connection = new Telnet()

    // Get connection settings from brand settings or device config
    const settings = this.getDeviceSettings(device)
    const timeout = settings.timeout || parseInt(process.env.TELNET_TIMEOUT) || 30000
    const execTimeout = settings.execTimeout || parseInt(process.env.COMMAND_TIMEOUT) || 10000

    // D-Link: Force cleanup of existing connections
    if (device.brand?.toLowerCase() === 'd-link') {
      logger.debug(`D-Link device detected: ${device.ip} - forcing cleanup before connection`)
    }

    // Use shellPrompt from settings if present, else default
    let shellPrompt = /[$%#>]/
    if (settings.shellPrompt) {
      try {
        // If shellPrompt is a string like '/.../', convert to RegExp
        if (typeof settings.shellPrompt === 'string' && settings.shellPrompt.startsWith('/')) {
          const match = settings.shellPrompt.match(/^\/(.*)\/(.*)$/)
          if (match) {
            shellPrompt = new RegExp(match[1], match[2] || '')
          }
        } else if (settings.shellPrompt instanceof RegExp) {
          shellPrompt = settings.shellPrompt
        }
      } catch { }
    }

    // Debug log (mask password)
    logger.debug(`Password for ${device.ip}: ${password ? password.replace(/./g, '*') : '[empty]'}`)

    const params = {
      host: device.ip,
      port: 23,
      shellPrompt: shellPrompt,
      timeout: timeout,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.credentials?.username || device.username || 'admin',
      password: password,
      execTimeout: execTimeout,
      debug: false
    }

    // Add source IP if specified in environment
    if (process.env.TELNET_SOURCE_IP) {
      params.localAddress = process.env.TELNET_SOURCE_IP
      logger.debug(`Using source IP: ${process.env.TELNET_SOURCE_IP} for connection to ${device.ip}`)
    }

    try {
      logger.info(`Connecting to device ${device.ip} (${device.name || device.description})`)
      logger.debug(`Connection params: host=${device.ip}, timeout=${timeout}, execTimeout=${execTimeout}`)

      // D-Link: try to clear possible hanging connections first
      if (device.brand?.toLowerCase() === 'd-link') {
        logger.debug(`D-Link connection attempt to ${device.ip}`)
      }

      await connection.connect(params)
      logger.info(`Successfully connected to ${device.ip}`)

      // Enter privileged mode if required
      logger.debug(`Checking enable requirements for ${device.ip}: settings.requiresEnable=${settings.requiresEnable}, device.requiresEnable=${device.requiresEnable}, device.enableCommand=${device.enableCommand}`)

      if ((settings.requiresEnable || device.requiresEnable) && device.enableCommand) {
        try {
          console.log(chalk.cyan(`✓ Enable condition met for ${device.ip} - sending command: ${device.enableCommand}`))
          logger.info(`Entering privileged mode on ${device.ip} with command: ${device.enableCommand}`)
          await connection.exec(device.enableCommand)
          console.log(chalk.green(`✓ Successfully entered privileged mode on ${device.ip}`))
          logger.info(`Successfully entered privileged mode on ${device.ip}`)
        } catch (error) {
          console.log(chalk.red(`✗ Failed to enter privileged mode on ${device.ip}: ${error.message}`))
          logger.warn(`Failed to enter privileged mode on ${device.ip}: ${error.message}`)
        }
      } else {
        console.log(chalk.gray(`- No enable command needed for ${device.ip}`))
      }

      return connection
    } catch (error) {
      logger.error(`Connection error to ${device.ip}: ${error.message}`)
      throw error
    }
  }

  async executeCommand(connection, command, device, isLastCommand = false) {
    const settings = this.getDeviceSettings(device)
    const connectionMethod = settings.connectionMethod || 'exec'

    if (connectionMethod === 'shell') {
      return await this.executeCommandWithShell(connection, command, device, isLastCommand)
    } else {
      return await this.executeCommandWithExec(connection, command, device)
    }
  }

  async executeCommandWithExec(connection, command, device) {
    try {
      logger.debug(`Executing command with exec() on ${device.ip}: ${command}`)
      let result = await connection.exec(command)
      let attempts = 0
      const maxAttempts = 200
      // Keep sending pagination input until prompt is gone (like standalone test)
      while (this.needsMoreInput(result, device) && attempts < maxAttempts) {
        logger.info(`Device ${device.ip} requires additional input (pagination)`)
        const moreData = await connection.exec(this.getDeviceSettings(device).paginationInput || ' ')
        result += moreData
        attempts++
      }
      if (attempts >= maxAttempts) {
        logger.warn(`Maximum pagination attempts reached for ${device.ip}`)
      }
      return result
    } catch (error) {
      logger.error(`Error executing command "${command}" on ${device.ip}: ${error.message}`)
      throw error
    }
  }

  async executeCommandWithShell(connection, command, device, isLastCommand = false) {
    logger.debug(`Executing command with shell() on ${device.ip}: ${command}`)

    // Use special D-Link logic if it's a D-Link device
    if (device.brand?.toLowerCase() === 'd-link') {
      return this.executeCommandForDLink(connection, command, device, isLastCommand)
    }

    const settings = this.getDeviceSettings(device)

    return new Promise((resolve, reject) => {
      let fullResult = ''
      let isComplete = false
      let commandTimeout

      connection.shell((error, stream) => {
        if (error) {
          reject(error)
          return
        }

        logger.debug(`Started shell session for ${device.ip}`)

        // Set timeout to prevent hanging
        const timeoutMs = settings.shellTimeout || 30000
        commandTimeout = setTimeout(() => {
          if (!isComplete) {
            logger.warn(`Command timeout for ${device.ip} - forcing completion`)
            isComplete = true
            stream.destroy()
          }
        }, timeoutMs)

        // Special shorter timeout for specific problematic BDCOM MAC device
        if (device.brand?.toLowerCase() === 'bdcom' && command.includes('mac') && device.ip === process.env.DEBUG_DEVICE_IP) {
          setTimeout(() => {
            if (!isComplete && fullResult.length > 1000) {
              logger.warn(`BDCOM MAC: Force completing after 30s, got ${fullResult.length} chars from ${device.ip}`)
              isComplete = true
              stream.destroy()
            }
          }, 30000)
        }

        // Send command immediately
        setTimeout(() => {
          logger.debug(`Sending command to ${device.ip}: ${command}`)
          stream.write(command + '\r\n')

          // Add timeout specifically for problematic BDCOM MAC device
          if (device.brand?.toLowerCase() === 'bdcom' && command.includes('mac') && device.ip === process.env.DEBUG_DEVICE_IP) {
            setTimeout(() => {
              if (fullResult.length < 100) {
                logger.warn(`BDCOM MAC: No significant data received after 10s from ${device.ip}, fullResult length: ${fullResult.length}`)
              }
            }, 10000)
          }
        }, 500)

        stream.on('data', (data) => {
          const output = data.toString()
          fullResult += output

          // Add debugging for specific BDCOM MAC table issue
          if (device.brand?.toLowerCase() === 'bdcom' && command.includes('mac') && device.ip === process.env.DEBUG_DEVICE_IP) {
            logger.debug(`BDCOM MAC data received from ${device.ip}: ${output.length} chars, last 100 chars: "${output.slice(-100)}"`)
          }

          // Check for pagination patterns
          if (this.needsMoreInput(output, device)) {
            logger.debug(`Pagination detected for ${device.ip} - sending continuation`)
            const paginationInput = settings.paginationInput || 'a'
            stream.write(paginationInput)

            // For D-Link, set flag to wait for more data after pagination
            if (device.brand?.toLowerCase() === 'd-link') {
              setTimeout(() => {
                // This timeout gives D-Link time to send all data after 'a'
              }, 500)
            }
          }
          // Check if command is complete (ends with prompt)
          else if (output.match(/[$%#>]\s*$/) && fullResult.length > command.length + 10) {
            if (!isComplete) {
              logger.debug(`Command completed for ${device.ip} - prompt detected`)
              isComplete = true
              setTimeout(() => {
                stream.destroy()
              }, 100)
            }
          }
        })

        stream.on('close', () => {
          logger.debug(`Shell session closed for ${device.ip}`)

          if (commandTimeout) {
            clearTimeout(commandTimeout)
          }

          // Clean the result
          let cleanResult = this.cleanShellResult(fullResult, command, device)

          if (cleanResult.length > 0) {
            resolve(cleanResult)
          } else {
            reject(new Error('No command output received'))
          }
        })

        stream.on('error', (err) => {
          logger.error(`Shell error for ${device.ip}: ${err.message}`)

          if (commandTimeout) {
            clearTimeout(commandTimeout)
          }

          reject(err)
        })
      })
    })
  }

  // Special method for D-Link devices with exact working logic from test
  async executeCommandForDLink(connection, command, device, isLastCommand = false) {
    logger.debug(`Executing D-Link command with shell(): ${command}`)

    return new Promise((resolve, reject) => {
      let fullResult = ''
      let isComplete = false
      let commandTimeout
      let inactivityTimer = null
      let streamClosed = false
      let logoutSent = false

      connection.shell((error, stream) => {
        if (error) {
          reject(error)
          return
        }

        logger.debug('Started D-Link shell session')

        // Set a timeout to prevent hanging
        commandTimeout = setTimeout(() => {
          if (!isComplete) {
            logger.warn('D-Link command timeout - forcing completion')
            isComplete = true
            if (!streamClosed) stream.destroy()
          }
        }, 30000) // 30 second timeout

        // Allow per-device override via inactivityTimeout (ms) in JSON, else default 1500
        const INACTIVITY_MS = (typeof device.inactivityTimeout === 'number' && device.inactivityTimeout > 0) ? device.inactivityTimeout : 1500
        function resetInactivityTimer() {
          if (inactivityTimer) clearTimeout(inactivityTimer)
          inactivityTimer = setTimeout(() => {
            if (!isComplete) {
              logger.debug(`D-Link inactivity timeout (${INACTIVITY_MS} ms): no more data, closing stream`)
              isComplete = true
              // Only send 'logout' if this is the last command
              if (isLastCommand && !logoutSent && !streamClosed) {
                logoutSent = true;
                logger.debug('Sending "logout" to D-Link before closing stream (last command)')
                stream.write('logout\r\n')
                setTimeout(() => {
                  if (!streamClosed) stream.destroy()
                }, 300)
              } else if (!streamClosed) {
                stream.destroy()
              }
            }
          }, INACTIVITY_MS)
        }

        // Send command immediately without waiting for prompt
        setTimeout(() => {
          logger.debug(`Sending D-Link command immediately: ${command}`)
          stream.write(command + '\r\n')
        }, 500) // Small delay to establish session

        stream.on('data', (data) => {
          const output = data.toString()
          fullResult += output

          // Log last 200 chars of each chunk for debug
          logger.debug(`D-Link output chunk (last 200 chars): "${output.slice(-200)}"`)

          // Reset inactivity timer on every data chunk
          resetInactivityTimer()

          // Check for D-Link pagination patterns
          if (this.needsMoreInput(output, device)) {
            logger.debug('D-Link pagination detected - sending "a"...')
            stream.write('a')
          }
          // Check if command is complete (ends with prompt)
          else if (output.match(/[$%#>]\s*$/) && fullResult.length > command.length + 10) {
            if (!isComplete) {
              logger.debug('D-Link command completed - prompt detected')
              isComplete = true
              // Only send 'logout' if this is the last command
              if (isLastCommand && !logoutSent && !streamClosed) {
                logoutSent = true;
                logger.debug('Sending "logout" to D-Link before closing stream (last command)')
                stream.write('logout\r\n')
                setTimeout(() => {
                  if (!streamClosed) stream.destroy()
                }, 300)
              } else if (!streamClosed) {
                setTimeout(() => {
                  stream.destroy()
                }, 100)
              }
            }
          }
        })

        // Only one close handler
        stream.on('close', () => {
          streamClosed = true
          if (inactivityTimer) clearTimeout(inactivityTimer)
          if (commandTimeout) clearTimeout(commandTimeout)
          logger.debug('D-Link shell session closed')

          if (!isComplete) {
            logger.warn('D-Link session closed without completion detection')
          }

          // Clean the result - remove prompts and command echo (D-Link specific)
          let cleanResult = fullResult
          const commandIndex = cleanResult.indexOf(command)
          if (commandIndex !== -1) {
            cleanResult = cleanResult.substring(commandIndex + command.length)
          }
          cleanResult = cleanResult.replace(/DGS-\d+-\d+SC:[a-zA-Z]+[#$>]\s*$/, '')
          cleanResult = cleanResult.replace(/[#$>]\s*$/, '')
          cleanResult = cleanResult.trim()

          logger.debug(`D-Link cleaned result: ${cleanResult.length} chars`)

          if (cleanResult.length > 0) {
            resolve(cleanResult)
          } else {
            reject(new Error('No D-Link command output received'))
          }
        })

        stream.on('error', (err) => {
          logger.error(`D-Link shell error: ${err.message}`)
          if (inactivityTimer) clearTimeout(inactivityTimer)
          if (commandTimeout) clearTimeout(commandTimeout)
          reject(err)
        })
      })
    })
  }

  needsMoreInput(output, device) {
    // D-Link specific patterns (flexible patterns from working test)
    const dlinkPatterns = [
      /Quit.*SPACE.*Next.*Page/i,
      /SPACE.*n.*Next.*Page/i,
      /ENTER.*Next.*Entry.*a.*All/i,
      /a All/i,
      /CTRL\+C ESC q Quit SPACE n Next Page ENTER Next Entry a All\s*/i,   // backup exact pattern
      /Press any key to continue \(Q to quit\)/i,
      /CTRL\+C ESC q Quit SPACE n Next Page\s*/i
    ]

    // Standard patterns for OLTs and other devices
    const standardPatterns = [
      /--More--/i,
      /Press any key to continue/i,
      /Press SPACE to continue/i,
      /Press Enter to continue/i,
      /\[Press 'A' for All or ENTER to continue\]/i,
      /Type <CR> to continue/i,
      /More\s*$/i
    ]

    // Choose patterns based on device brand
    const brand = device.brand?.toLowerCase()
    let patterns

    if (brand === 'd-link' || brand === 'dlink') {
      patterns = dlinkPatterns
      // Debug output for D-Link
      const hasMore = patterns.some(pattern => pattern.test(output))
      if (hasMore) {
        logger.debug(`D-Link pagination pattern matched in: "${output.slice(-100)}"`)
      } else {
        logger.debug(`D-Link pagination pattern NOT matched in: "${output.slice(-100)}"`)
      }
      return hasMore
    } else {
      patterns = standardPatterns
    }

    return patterns.some(pattern => pattern.test(output))
  }

  async handleMoreInputWithExec(connection, device) {
    let additionalOutput = ''
    let attempts = 0
    const maxAttempts = 50
    const settings = this.getDeviceSettings(device)
    const inputChar = settings.paginationInput || ' '

    logger.debug(`Starting exec pagination for ${device.ip} with input: "${inputChar}"`)

    while (attempts < maxAttempts) {
      try {
        // Send pagination input
        const moreData = await connection.exec(inputChar)
        additionalOutput += moreData

        if (!this.needsMoreInput(moreData, device)) {
          logger.debug(`Pagination completed for ${device.ip} after ${attempts + 1} attempts`)
          break
        }

        attempts++
        logger.debug(`Received additional data from ${device.ip} (attempt ${attempts})`)

        // Small pause between requests
        await this.sleep(500)
      } catch (error) {
        logger.warn(`Error receiving additional data from ${device.ip}: ${error.message}`)
        break
      }
    }

    if (attempts >= maxAttempts) {
      logger.warn(`Maximum pagination attempts reached for ${device.ip}`)
    }

    return additionalOutput
  }

  cleanShellResult(fullResult, command, device) {
    let cleanResult = fullResult

    // Remove everything before the command
    const commandIndex = cleanResult.indexOf(command)
    if (commandIndex !== -1) {
      cleanResult = cleanResult.substring(commandIndex + command.length)
    }

    // Remove trailing prompts based on device type
    const brand = device.brand?.toLowerCase()
    if (brand === 'd-link' || brand === 'dlink') {
      cleanResult = cleanResult.replace(/DGS-\d+-\d+SC:[a-zA-Z]+[#$>]\s*$/, '')
    }
    cleanResult = cleanResult.replace(/[#$>]\s*$/, '')
    cleanResult = cleanResult.trim()

    logger.debug(`Cleaned result for ${device.ip}: ${cleanResult.length} chars`)
    return cleanResult
  }

  async collectConfigs() {
    logger.info('Starting configuration and MAC table collection')

    for (const device of this.devices) {
      const brand = (device.brand || device.vendor || '').toLowerCase()
      let connection = null

      try {
        connection = await this.connectToDevice(device)

        // For Cisco: send 'terminal length 0' before commands
        if (brand === 'cisco') {
          try {
            await this.executeCommand(connection, 'terminal length 0', device)
            await this.sleep(500)
          } catch (e) {
            logger.warn(`Failed to set terminal length 0 on ${device.ip}: ${e.message}`)
          }
        }

        // Calculate total commands for D-Link logout logic
        let totalCommands = device.commands.config.length + device.commands.mac.length
        // Add 1 for config append command if needed
        if (brand === 'd-link' && device.appendMissingConfig) {
          totalCommands += 1
        }
        let commandIndex = 0

        // Collect configurations
        for (const command of device.commands.config) {
          try {
            commandIndex++
            const isLastCommand = commandIndex === totalCommands
            const output = await this.executeCommand(connection, command, device, isLastCommand)
            // Save configuration
            const filename = `${device.ip.replace(/\./g, '_')}.cfg`
            const filepath = path.join(this.configsDir, filename)
            await fs.writeFile(filepath, output, 'utf8')
            logger.info(`Configuration saved: ${filepath}`)
            // Pause between commands (only if not the last command)
            if (!isLastCommand) {
              await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000)
            }
          } catch (error) {
            logger.error(`Error collecting configuration from ${device.ip} with command "${command}": ${error.message}`)
          }
        }

        // For D-Link devices with appendMissingConfig: try to get remaining config data
        if (brand === 'd-link' && device.appendMissingConfig) {
          try {
            commandIndex++
            const isLastCommand = commandIndex === totalCommands
            logger.info(`D-Link ${device.ip}: Attempting to collect remaining configuration data`)
            const remainingOutput = await this.executeCommand(connection, 'show config effective', device, isLastCommand)

            // Check if we got meaningful remaining config (not just prompt)
            if (remainingOutput && remainingOutput.length > 50 && !remainingOutput.includes('Command: logout')) {
              // Append to existing config file
              const filename = `${device.ip.replace(/\./g, '_')}.cfg`
              const filepath = path.join(this.configsDir, filename)
              const existingConfig = await fs.readFile(filepath, 'utf8')
              const completedConfig = existingConfig + '\n' + remainingOutput
              await fs.writeFile(filepath, completedConfig, 'utf8')
              logger.info(`D-Link ${device.ip}: Appended remaining configuration data`)
            } else {
              logger.debug(`D-Link ${device.ip}: No meaningful remaining config data found`)
            }

            // Pause before MAC commands (only if not the last command)
            if (!isLastCommand) {
              await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000)
            }
          } catch (error) {
            logger.warn(`D-Link ${device.ip}: Error collecting remaining config: ${error.message}`)
          }
        }

        // Collect MAC tables in the same session
        for (const command of device.commands.mac) {
          try {
            commandIndex++
            const isLastCommand = commandIndex === totalCommands
            const output = await this.executeCommand(connection, command, device, isLastCommand)

            // For D-Link devices: clean output from config remnants
            let cleanOutput = output
            if (brand === 'd-link') {
              // Remove config-like content that might have leaked into MAC output
              const configPatterns = [
                /^#.*$/gm,
                /^config .*$/gm,
                /^create .*$/gm,
                /^disable .*$/gm,
                /^enable .*$/gm,
                /^\s*DGS-.*$/gm,
                /Command: logout.*$/gs,
                /\*+\s*Logout\s*\*+/gs
              ]

              configPatterns.forEach(pattern => {
                cleanOutput = cleanOutput.replace(pattern, '')
              })

              // Remove empty lines
              cleanOutput = cleanOutput.replace(/^\s*[\r\n]/gm, '')
              cleanOutput = cleanOutput.trim()

              logger.debug(`D-Link ${device.ip}: Cleaned MAC output from ${output.length} to ${cleanOutput.length} chars`)
            }

            // Save MAC table
            const filename = `${device.ip.replace(/\./g, '_')}.mac`
            const filepath = path.join(this.macTablesDir, filename)
            await fs.writeFile(filepath, cleanOutput, 'utf8')
            logger.info(`MAC table saved: ${filepath}`)
            // Pause between commands (only if not the last command)
            if (!isLastCommand) {
              await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000)
            }
          } catch (error) {
            logger.error(`Error collecting MAC table from ${device.ip} with command "${command}": ${error.message}`)
          }
        }

      } catch (error) {
        logger.error(`Error connecting to ${device.ip}: ${error.message}`)
      } finally {
        if (connection) {
          try {
            logger.debug(`Closing connection to ${device.ip}`)
            await connection.end()
            logger.debug(`Connection closed to ${device.ip}`)
          } catch (error) {
            logger.warn(`Error closing connection to ${device.ip}: ${error.message}`)
            // D-Link: force destroy connection
            if (brand === 'd-link') {
              try {
                logger.debug(`Force destroying D-Link connection to ${device.ip}`)
                connection.destroy()
              } catch (e) {
                logger.debug(`Failed to destroy connection: ${e.message}`)
              }
            }
          }
        }
        // D-Link: pause after connection close
        if (brand === 'd-link') {
          logger.info('Pausing after D-Link connection close to allow device to release session...')
          await this.sleep(8000) // Extended pause to 8 seconds
        }
      }
    }
  }

  async collectMacTables() {
    logger.info('Starting MAC table collection')
    for (const device of this.devices) {
      const brand = (device.brand || device.vendor || '').toLowerCase()
      for (const command of device.commands.mac) {
        let connection = null
        try {
          connection = await this.connectToDevice(device)
          // For Cisco: send 'terminal length 0' before MAC table command
          if (brand === 'cisco') {
            try {
              await this.executeCommand(connection, 'terminal length 0', device)
              await this.sleep(500)
            } catch (e) {
              logger.warn(`Failed to set terminal length 0 on ${device.ip}: ${e.message}`)
            }
          }
          const output = await this.executeCommand(connection, command, device)
          // Save MAC table
          const filename = `${device.ip.replace(/\./g, '_')}.mac`
          const filepath = path.join(this.macTablesDir, filename)
          await fs.writeFile(filepath, output, 'utf8')
          logger.info(`MAC table saved: ${filepath}`)
        } catch (error) {
          logger.error(`Error collecting MAC table from ${device.ip}: ${error.message}`)
        } finally {
          if (connection) {
            try {
              logger.debug(`Closing MAC connection to ${device.ip}`)
              await connection.end()
              logger.debug(`MAC connection closed to ${device.ip}`)
            } catch (error) {
              logger.warn(`Error closing MAC connection to ${device.ip}: ${error.message}`)
              // D-Link: force destroy connection
              if (brand === 'd-link') {
                try {
                  logger.debug(`Force destroying D-Link MAC connection to ${device.ip}`)
                  connection.destroy()
                } catch (e) {
                  logger.debug(`Failed to destroy MAC connection: ${e.message}`)
                }
              }
            }
          }
          // D-Link: pause after connection close
          if (brand === 'd-link') {
            logger.info('Pausing after D-Link connection close to allow device to release session...')
            await this.sleep(8000)
          }
        }
        // Pause between commands
        await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000)
      }
    }
  }

  async collectAll() {
    // Now collectConfigs handles both configs and MAC tables in one session
    await this.collectConfigs()
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async showDeviceList() {
    console.log(chalk.cyan('\n=== Device List ==='))
    this.devices.forEach((device, index) => {
      console.log(chalk.yellow(`${index + 1}. ${device.ip} - ${device.description} (${device.type}/${device.vendor})`))
    })
    console.log('')
  }
}

// Main function
async function main() {
  const args = process.argv.slice(2)
  // Support --devices=FILENAME.json argument
  let devicesFileOverride = null
  for (const arg of args) {
    if (arg.startsWith('--devices=')) {
      devicesFileOverride = arg.replace('--devices=', '').trim()
    }
  }
  const collector = new NetworkDeviceCollector(devicesFileOverride)

  try {
    await collector.init()
    await collector.showDeviceList()

    if (args.includes('--config') || args.includes('--configs')) {
      await collector.collectConfigs()
    } else if (args.includes('--mac') || args.includes('--macs')) {
      await collector.collectMacTables()
    } else if (args.includes('--all')) {
      await collector.collectAll()
    } else {
      // Auto collect both configs and MAC tables (like in test scripts)
      logger.info('Starting automatic collection of configurations and MAC tables')
      await collector.collectAll()
    }

    logger.info('Data collection completed')
  } catch (error) {
    logger.error(`Critical error: ${error.message}`)
    process.exit(1)
  }
}

// Handle termination signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT signal, shutting down...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM signal, shutting down...')
  process.exit(0)
})

// Start application
if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`Fatal error: ${error.message}`))
    process.exit(1)
  })
}

module.exports = NetworkDeviceCollector
