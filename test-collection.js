#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Telnet } = require('telnet-client');
const chalk = require('chalk');
const inquirer = require('inquirer');

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
  ];
  
  // Convert string prompts to regex
  const patterns = prompts.map(prompt => {
    if (typeof prompt === 'string') {
      return new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    return prompt;
  });
  
  const hasMore = patterns.some(pattern => pattern.test(output));
  
  if (hasMore) {
    console.log(chalk.blue(`DEBUG: Pagination detected with BDCOM pattern`));
  }
  
  return hasMore;
}async function handleMoreInput(connection, device) {
  let additionalOutput = '';
  let attempts = 0;
  const maxAttempts = 200;
  const inputChar = device.paginationInput || ' ';

  console.log(chalk.cyan(`  Starting pagination handling with input: "${inputChar}"`));

  while (attempts < maxAttempts) {
    try {
      console.log(chalk.gray(`    Sending "${inputChar}" to continue... (${attempts + 1}/${maxAttempts})`));
      const moreResult = await connection.exec(inputChar);
      additionalOutput += moreResult;
      
      // Show last part of current result
      console.log(chalk.blue(`    Last 100 chars: "${moreResult.slice(-100)}"`));

      // Check if we need to continue
      if (!needsMoreInput(moreResult, device)) {
        console.log(chalk.green(`  ✓ Pagination completed after ${attempts + 1} attempts`));
        break;
      }

      attempts++;

    } catch (error) {
      console.log(chalk.red(`  Error handling more input: ${error.message}`));
      break;
    }
  }

  if (attempts >= maxAttempts) {
    console.log(chalk.yellow(`  Maximum attempts (${maxAttempts}) reached for pagination`));
  }

  return additionalOutput;
}

async function executeCommand(connection, command, device) {
  try {
    console.log(chalk.yellow(`\nTrying command: ${command}`));

    // Send command
    let result = await connection.exec(command);
    
    // DEBUG: Show the end of result to see pagination prompt
    console.log(chalk.blue(`DEBUG: Last 200 chars of result:`));
    console.log(chalk.blue(`"${result.slice(-200)}"`));

    // Check if additional interaction is required
    if (needsMoreInput(result, device)) {
      console.log(chalk.cyan('  Device requires additional input for pagination'));
      result += await handleMoreInput(connection, device);
    } else {
      console.log(chalk.gray('  No pagination detected'));
    }

    return result;
  } catch (error) {
    throw error;
  }
}

async function testDataCollection() {
  try {
    // Device configuration
    const device = {
      ip: "192.168.165.191",
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
      timeout: 30000,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: device.username,
      password: answers.password,
      execTimeout: 60000,
      debug: false
    };

    await connection.connect(params);
    console.log(chalk.green(`✓ Connected to ${device.ip}`));

    // Enter privileged mode if required
    if (device.requiresEnable && device.enableCommand) {
      try {
        console.log(chalk.yellow(`\nEntering privileged mode with command: ${device.enableCommand}`));
        await connection.exec(device.enableCommand);
        console.log(chalk.green('✓ Entered privileged mode'));
      } catch (error) {
        console.log(chalk.red(`✗ Failed to enter privileged mode: ${error.message}`));
      }
    }

    // First, get available commands
    console.log(chalk.cyan('\n=== Getting Available Commands ==='));
    try {
      console.log(chalk.yellow('\nTrying command: help'));
      const helpResult = await connection.exec('help');
      console.log(chalk.green('✓ Help command result:'));
      console.log(chalk.gray(helpResult.substring(0, 1000) + (helpResult.length > 1000 ? '\n... (truncated)' : '')));
    } catch (error) {
      console.log(chalk.red(`✗ Help command failed: ${error.message}`));

      try {
        console.log(chalk.yellow('\nTrying command: ?'));
        const questionResult = await connection.exec('?');
        console.log(chalk.green('✓ ? command result:'));
        console.log(chalk.gray(questionResult.substring(0, 1000) + (questionResult.length > 1000 ? '\n... (truncated)' : '')));
      } catch (error2) {
        console.log(chalk.red(`✗ ? command also failed: ${error2.message}`));
      }
    }

    // Test config commands
    console.log(chalk.cyan('\n=== Testing Configuration Commands ==='));
    for (const command of device.commands.config) {
      try {
        const result = await executeCommand(connection, command, device);

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
        const result = await executeCommand(connection, command, device);

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
