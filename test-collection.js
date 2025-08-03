#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Telnet } = require('telnet-client');
const chalk = require('chalk');
const inquirer = require('inquirer');

async function testDataCollection() {
  try {
    // Device configuration
    const device = {
      ip: "192.168.165.191",
      type: "olt",
      vendor: "unknown",
      username: "admin",
      password: null,
      commands: {
        config: ["show config", "display current-configuration", "show running-config"],
        mac: ["show mac", "show fdb", "show mac address-table", "display mac-address"]
      },
      description: "OLT_Tatsenky"
    };

    // Get password
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'password',
        message: 'Enter device password:',
        mask: '*'
      }
    ]);

    console.log(chalk.yellow(`\nConnecting to ${device.ip} (${device.description})...`));

    // Connect to device
    const connection = new Telnet();
    const params = {
      host: device.ip,
      port: 23,
      shellPrompt: /[$%#>]/,
      timeout: 15000,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.username,
      password: answers.password,
      execTimeout: 10000,
      debug: false
    };

    await connection.connect(params);
    console.log(chalk.green(`✓ Connected to ${device.ip}`));

    // Test config commands
    console.log(chalk.cyan('\n=== Testing Configuration Commands ==='));
    for (const command of device.commands.config) {
      try {
        console.log(chalk.yellow(`\nTrying command: ${command}`));
        const result = await connection.exec(command);
        
        if (result && result.trim().length > 0) {
          console.log(chalk.green(`✓ Command "${command}" successful`));
          console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`));
          
          // Save configuration
          const configDir = './configs';
          await fs.mkdir(configDir, { recursive: true });
          const filename = `${device.ip.replace(/\./g, '_')}.cfg`;
          const filepath = path.join(configDir, filename);
          await fs.writeFile(filepath, result, 'utf8');
          console.log(chalk.green(`Configuration saved: ${filepath}`));
          break; // Use first working command
        } else {
          console.log(chalk.red(`✗ Command "${command}" returned empty result`));
        }
      } catch (error) {
        console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`));
      }
    }

    // Test MAC commands
    console.log(chalk.cyan('\n=== Testing MAC Table Commands ==='));
    for (const command of device.commands.mac) {
      try {
        console.log(chalk.yellow(`\nTrying command: ${command}`));
        const result = await connection.exec(command);
        
        if (result && result.trim().length > 0) {
          console.log(chalk.green(`✓ Command "${command}" successful`));
          console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`));
          
          // Save MAC table
          const macDir = './mac_tables';
          await fs.mkdir(macDir, { recursive: true });
          const filename = `${device.ip.replace(/\./g, '_')}.mac`;
          const filepath = path.join(macDir, filename);
          await fs.writeFile(filepath, result, 'utf8');
          console.log(chalk.green(`MAC table saved: ${filepath}`));
          break; // Use first working command
        } else {
          console.log(chalk.red(`✗ Command "${command}" returned empty result`));
        }
      } catch (error) {
        console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`));
      }
    }

    await connection.end();
    console.log(chalk.green('\n✓ Data collection test completed'));

  } catch (error) {
    console.error(chalk.red(`\n✗ Test error: ${error.message}`));
  }
}

if (require.main === module) {
  console.log(chalk.cyan('=== Data Collection Test ===\n'));
  testDataCollection().catch(console.error);
}
