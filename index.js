#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Telnet } = require('telnet-client');
const chalk = require('chalk');
const inquirer = require('inquirer');
const winston = require('winston');

// Logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
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
});

class NetworkDeviceCollector {
  constructor() {
    this.devices = [];
    this.globalPassword = null;
    this.configsDir = process.env.CONFIGS_DIR || './configs';
    this.macTablesDir = process.env.MAC_TABLES_DIR || './mac_tables';
    this.logsDir = process.env.LOGS_DIR || './logs';
    this.devicesFile = process.env.DEVICES_FILE || './data/devices.json';
  }

  async init() {
    try {
      // Create necessary directories
      await this.ensureDirectories();
      
      // Load device list
      await this.loadDevices();
      
      // Ask user for password
      await this.askForPassword();
      
      logger.info('Initialization completed successfully');
    } catch (error) {
      logger.error(`Initialization error: ${error.message}`);
      throw error;
    }
  }

  async ensureDirectories() {
    const dirs = [this.configsDir, this.macTablesDir, this.logsDir];
    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
        logger.debug(`Directory created: ${dir}`);
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  async loadDevices() {
    try {
      const data = await fs.readFile(this.devicesFile, 'utf8');
      this.devices = JSON.parse(data);
      logger.info(`Loaded ${this.devices.length} devices`);
    } catch (error) {
      logger.error(`Error loading devices file: ${error.message}`);
      throw error;
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
    ]);
    this.globalPassword = answers.password;
  }

  async connectToDevice(device) {
    const connection = new Telnet();
    const params = {
      host: device.ip,
      port: 23,
      shellPrompt: /[$%#>]/,
      timeout: parseInt(process.env.TELNET_TIMEOUT) || 30000,
      loginPrompt: /login[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.username || 'admin',
      password: device.password || this.globalPassword,
      execTimeout: parseInt(process.env.COMMAND_TIMEOUT) || 10000
    };

    try {
      logger.info(`Connecting to device ${device.ip} (${device.description})`);
      await connection.connect(params);
      logger.info(`Successfully connected to ${device.ip}`);
      return connection;
    } catch (error) {
      logger.error(`Connection error to ${device.ip}: ${error.message}`);
      throw error;
    }
  }

  async executeCommand(connection, command, device) {
    try {
      logger.debug(`Executing command on ${device.ip}: ${command}`);
      
      // Send command
      let result = await connection.exec(command);
      
      // Check if additional interaction is required
      if (this.needsMoreInput(result)) {
        logger.info(`Device ${device.ip} requires additional input`);
        result += await this.handleMoreInput(connection, device);
      }
      
      return result;
    } catch (error) {
      logger.error(`Error executing command "${command}" on ${device.ip}: ${error.message}`);
      throw error;
    }
  }

  needsMoreInput(output) {
    const morePatterns = [
      /--More--/i,
      /Press any key to continue/i,
      /Press SPACE to continue/i,
      /Press Enter to continue/i,
      /\[Press 'A' for All or ENTER to continue\]/i,
      /Type <CR> to continue/i
    ];
    
    return morePatterns.some(pattern => pattern.test(output));
  }

  async handleMoreInput(connection, device) {
    let additionalOutput = '';
    let attempts = 0;
    const maxAttempts = 50; // Limit number of attempts
    
    while (attempts < maxAttempts) {
      try {
        // Send space to continue
        const moreData = await connection.exec(' ');
        additionalOutput += moreData;
        
        if (!this.needsMoreInput(moreData)) {
          break;
        }
        
        attempts++;
        logger.debug(`Received additional data from ${device.ip} (attempt ${attempts})`);
        
        // Small pause between requests
        await this.sleep(500);
      } catch (error) {
        logger.warn(`Error receiving additional data from ${device.ip}: ${error.message}`);
        break;
      }
    }
    
    if (attempts >= maxAttempts) {
      logger.warn(`Maximum attempts reached for ${device.ip}`);
    }
    
    return additionalOutput;
  }

  async collectConfigs() {
    logger.info('Starting configuration collection');
    
    for (const device of this.devices) {
      let connection = null;
      try {
        connection = await this.connectToDevice(device);
        
        for (const command of device.commands.config) {
          const output = await this.executeCommand(connection, command, device);
          
          // Save configuration
          const filename = `${device.ip.replace(/\./g, '_')}.cfg`;
          const filepath = path.join(this.configsDir, filename);
          
          await fs.writeFile(filepath, output, 'utf8');
          logger.info(`Configuration saved: ${filepath}`);
        }
        
      } catch (error) {
        logger.error(`Error collecting configuration from ${device.ip}: ${error.message}`);
      } finally {
        if (connection) {
          try {
            await connection.end();
          } catch (error) {
            logger.warn(`Error closing connection to ${device.ip}: ${error.message}`);
          }
        }
      }
      
      // Pause between devices
      await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000);
    }
  }

  async collectMacTables() {
    logger.info('Starting MAC table collection');
    
    for (const device of this.devices) {
      let connection = null;
      try {
        connection = await this.connectToDevice(device);
        
        for (const command of device.commands.mac) {
          const output = await this.executeCommand(connection, command, device);
          
          // Save MAC table
          const filename = `${device.ip.replace(/\./g, '_')}.mac`;
          const filepath = path.join(this.macTablesDir, filename);
          
          await fs.writeFile(filepath, output, 'utf8');
          logger.info(`MAC table saved: ${filepath}`);
        }
        
      } catch (error) {
        logger.error(`Error collecting MAC table from ${device.ip}: ${error.message}`);
      } finally {
        if (connection) {
          try {
            await connection.end();
          } catch (error) {
            logger.warn(`Error closing connection to ${device.ip}: ${error.message}`);
          }
        }
      }
      
      // Pause between devices
      await this.sleep(parseInt(process.env.COMMAND_DELAY) || 2000);
    }
  }

  async collectAll() {
    await this.collectConfigs();
    await this.collectMacTables();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async showDeviceList() {
    console.log(chalk.cyan('\n=== Device List ==='));
    this.devices.forEach((device, index) => {
      console.log(chalk.yellow(`${index + 1}. ${device.ip} - ${device.description} (${device.type}/${device.vendor})`));
    });
    console.log('');
  }
}

// Main function
async function main() {
  const args = process.argv.slice(2);
  const collector = new NetworkDeviceCollector();

  try {
    await collector.init();
    await collector.showDeviceList();

    if (args.includes('--configs')) {
      await collector.collectConfigs();
    } else if (args.includes('--macs')) {
      await collector.collectMacTables();
    } else if (args.includes('--all')) {
      await collector.collectAll();
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
      ]);

      switch (answers.action) {
        case 'configs':
          await collector.collectConfigs();
          break;
        case 'macs':
          await collector.collectMacTables();
          break;
        case 'all':
          await collector.collectAll();
          break;
        case 'exit':
          logger.info('Exiting program');
          process.exit(0);
      }
    }

    logger.info('Data collection completed');
  } catch (error) {
    logger.error(`Critical error: ${error.message}`);
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT signal, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM signal, shutting down...');
  process.exit(0);
});

// Start application
if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`Fatal error: ${error.message}`));
    process.exit(1);
  });
}

module.exports = NetworkDeviceCollector;
