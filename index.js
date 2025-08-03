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
  constructor() {
    this.devices = []
    this.brandSettings = {}
    this.globalPassword = null
    this.configsDir = process.env.CONFIGS_DIR || './configs'
    this.macTablesDir = process.env.MAC_TABLES_DIR || './mac_tables'
    this.logsDir = process.env.LOGS_DIR || './logs'
    
    // Build full path to devices file
    const dataDir = process.env.DATA_DIR || './data'
    const devicesFileName = process.env.DEVICES_FILE || 'devices.json'
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
      
      // Ask user for password
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
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: 'Enter administrator password for devices:',
        mask: '*'
      }
    ])
    this.globalPassword = answers.password
  }

  getDeviceSettings(device) {
    // First try to get settings from device-specific connectionSettings
    if (device.connectionSettings) {
      return device.connectionSettings
    }
    
    // Then try to get settings by brand
    const brand = device.brand
    if (brand && this.brandSettings[brand]) {
      logger.debug(`Using brand settings for ${device.ip} (${brand})`)
      return this.brandSettings[brand]
    }
    
    // Fall back to default settings
    logger.debug(`Using default settings for ${device.ip}`)
    return {
      connectionMethod: 'exec',
      paginationMethod: 'exec',
      timeout: 30000,
      shellPrompt: '/[$%#>]/',
      requiresEnable: false,
      paginationInput: ' ',
      commandTimeout: 10000,
      execTimeout: 30000
    }
  }

  async connectToDevice(device) {
    const connection = new Telnet()
    
    // Get connection settings from brand settings or device config
    const settings = this.getDeviceSettings(device)
    const timeout = settings.timeout || parseInt(process.env.TELNET_TIMEOUT) || 30000
    const execTimeout = settings.execTimeout || parseInt(process.env.COMMAND_TIMEOUT) || 10000
    
    const params = {
      host: device.ip,
      port: 23,
      shellPrompt: /[$%#>]/,
      timeout: timeout,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.credentials?.username || device.username || 'admin',
      password: device.credentials?.password || device.password || this.globalPassword,
      execTimeout: execTimeout,
      debug: false
    }

    try {
      logger.info(`Connecting to device ${device.ip} (${device.name || device.description})`)
      await connection.connect(params)
      logger.info(`Successfully connected to ${device.ip}`)
      
      // Enter privileged mode if required
      if (settings.requiresEnable && device.enableCommand) {
        try {
          logger.info(`Entering privileged mode on ${device.ip} with command: ${device.enableCommand}`)
          await connection.exec(device.enableCommand)
          logger.info(`Successfully entered privileged mode on ${device.ip}`)
        } catch (error) {
          logger.warn(`Failed to enter privileged mode on ${device.ip}: ${error.message}`)
        }
      }
      
      return connection
    } catch (error) {
      logger.error(`Connection error to ${device.ip}: ${error.message}`)
      throw error
    }
  }

  async executeCommand(connection, command, device) {
    const settings = this.getDeviceSettings(device)
    const connectionMethod = settings.connectionMethod || 'exec'
    
    if (connectionMethod === 'shell') {
      return await this.executeCommandWithShell(connection, command, device)
    } else {
      return await this.executeCommandWithExec(connection, command, device)
    }
  }

  async executeCommandWithExec(connection, command, device) {
    try {
      logger.debug(`Executing command with exec() on ${device.ip}: ${command}`)
      
      // Send command
      let result = await connection.exec(command)
      
      // Check if additional interaction is required
      if (this.needsMoreInput(result, device)) {
        logger.info(`Device ${device.ip} requires additional input`)
        result += await this.handleMoreInputWithExec(connection, device)
      }
      
      return result
    } catch (error) {
      logger.error(`Error executing command "${command}" on ${device.ip}: ${error.message}`)
      throw error
    }
  }

  async executeCommandWithShell(connection, command, device) {
    logger.debug(`Executing command with shell() on ${device.ip}: ${command}`)
    
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
        
        // Send command immediately
        setTimeout(() => {
          logger.debug(`Sending command to ${device.ip}: ${command}`)
          stream.write(command + '\r\n')
        }, 500)
        
        stream.on('data', (data) => {
          const output = data.toString()
          fullResult += output
          
          // Check for pagination patterns
          if (this.needsMoreInput(output, device)) {
            logger.debug(`Pagination detected for ${device.ip} - sending continuation`)
            const paginationInput = settings.paginationInput || 'a'
            stream.write(paginationInput)
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

  needsMoreInput(output, device) {
    // D-Link specific patterns
    const dlinkPatterns = [
      /CTRL\+C ESC q Quit SPACE n Next Page ENTER Next Entry a All/i,
      /Press any key to continue \(Q to quit\)/i,
      /CTRL\+C ESC q Quit SPACE n Next Page/i
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
    logger.info('Starting configuration collection')
    
    for (const device of this.devices) {
      let connection = null
      try {
        connection = await this.connectToDevice(device)
        
        for (const command of device.commands.config) {
          const output = await this.executeCommand(connection, command, device)
          
          // Save configuration
          const filename = `${device.ip.replace(/\./g, '_')}.cfg`
          const filepath = path.join(this.configsDir, filename)
          
          await fs.writeFile(filepath, output, 'utf8')
          logger.info(`Configuration saved: ${filepath}`)
        }
        
      } catch (error) {
        logger.error(`Error collecting configuration from ${device.ip}: ${error.message}`)
      } finally {
        if (connection) {
          try {
            await connection.end()
          } catch (error) {
            logger.warn(`Error closing connection to ${device.ip}: ${error.message}`)
          }
        }
      }
      
      // Pause between devices
      await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000)
    }
  }

  async collectMacTables() {
    logger.info('Starting MAC table collection')
    
    for (const device of this.devices) {
      let connection = null
      try {
        connection = await this.connectToDevice(device)
        
        for (const command of device.commands.mac) {
          const output = await this.executeCommand(connection, command, device)
          
          // Save MAC table
          const filename = `${device.ip.replace(/\./g, '_')}.mac`
          const filepath = path.join(this.macTablesDir, filename)
          
          await fs.writeFile(filepath, output, 'utf8')
          logger.info(`MAC table saved: ${filepath}`)
        }
        
      } catch (error) {
        logger.error(`Error collecting MAC table from ${device.ip}: ${error.message}`)
      } finally {
        if (connection) {
          try {
            await connection.end()
          } catch (error) {
            logger.warn(`Error closing connection to ${device.ip}: ${error.message}`)
          }
        }
      }
      
      // Pause between devices
      await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000)
    }
  }

  async collectAll() {
    await this.collectConfigs()
    await this.collectMacTables()
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
  const collector = new NetworkDeviceCollector()

  try {
    await collector.init()
    await collector.showDeviceList()

    if (args.includes('--configs')) {
      await collector.collectConfigs()
    } else if (args.includes('--macs')) {
      await collector.collectMacTables()
    } else if (args.includes('--all')) {
      await collector.collectAll()
    } else {
      // Interactive menu
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Choose action:',
          choices: [
            { name: 'Collect configurations', value: 'configs' },
            { name: 'Collect MAC tables', value: 'macs' },
            { name: 'Collect all', value: 'all' },
            { name: 'Exit', value: 'exit' }
          ]
        }
      ])

      switch (answers.action) {
        case 'configs':
          await collector.collectConfigs()
          break
        case 'macs':
          await collector.collectMacTables()
          break
        case 'all':
          await collector.collectAll()
          break
        case 'exit':
          logger.info('Exiting program')
          process.exit(0)
      }
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
