#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Telnet } = require('telnet-client');
const chalk = require('chalk');
const inquirer = require('inquirer');

// Functions for handling pagination
function needsMoreInput(output, device) {
  // D-Link specific patterns - look for key words
  const dlinkPatterns = [
    /Quit.*SPACE.*Next.*Page/i,
    /SPACE.*n.*Next.*Page/i,
    /ENTER.*Next.*Entry.*a.*All/i,
    /a All/i
  ];
  
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
  ];
  
  // Combine D-Link patterns with generic ones
  const allPatterns = [...dlinkPatterns, ...prompts];
  
  // Convert string prompts to regex
  const patterns = allPatterns.map(prompt => {
    if (typeof prompt === 'string') {
      return new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    return prompt;
  });
  
  const hasMore = patterns.some(pattern => pattern.test(output));
  
  if (hasMore) {
    console.log(chalk.blue(`DEBUG: Pagination detected with D-Link pattern in: "${output.slice(-150)}"`));
  }
  
  return hasMore;
}

async function handleMoreInput(connection, device) {
  let additionalOutput = '';
  let attempts = 0;
  const maxAttempts = 200;
  const inputChar = device.paginationInput || 'a';

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
  // Try exec method first for D-Link
  try {
    console.log(chalk.yellow(`\nTrying command with exec(): ${command}`));
    const result = await connection.exec(command);
    console.log(chalk.green(`✓ Command executed successfully with exec()`));
    console.log(chalk.gray(`Result length: ${result.length} chars`));
    console.log(chalk.gray(`Result preview: "${result.substring(0, 200)}"`));
    return result;
  } catch (execError) {
    console.log(chalk.red(`exec() failed: ${execError.message}`));
    console.log(chalk.yellow(`Falling back to shell() method...`));
  }

  // Fallback to shell method
  return new Promise((resolve, reject) => {
    console.log(chalk.yellow(`\nTrying command with shell(): ${command}`));
    
    let fullResult = '';
    let isComplete = false;
    
    // Use shell() method for raw interaction
    connection.shell((error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      
      console.log(chalk.gray('Started shell session for command execution'));
      
      // Set up data handler
      stream.on('data', (data) => {
        const output = data.toString();
        fullResult += output;
        
        console.log(chalk.blue(`Received data (${output.length} chars): "${output.slice(-100)}"`));
        
        // Check if we need to handle pagination
        if (needsMoreInput(output, device)) {
          console.log(chalk.cyan('Pagination detected - sending "a" for All...'));
          stream.write(device.paginationInput || 'a');
        }
        // Check if command is complete (ends with prompt)
        else if (output.match(/[$%#>]\s*$/)) {
          console.log(chalk.green('Command completed - prompt detected'));
          isComplete = true;
          
          // Immediately resolve with result before ending stream
          resolve(fullResult);
          
          // Then end the stream
          setTimeout(() => {
            stream.end();
          }, 100);
        }
      });
      
      stream.on('close', () => {
        console.log(chalk.gray('Shell session closed'));
        if (isComplete) {
          console.log(chalk.green(`✓ Command completed, result length: ${fullResult.length}`));
          resolve(fullResult);
        } else {
          reject(new Error('Command did not complete properly'));
        }
      });
      
      stream.on('error', (err) => {
        console.log(chalk.red(`Shell error: ${err.message}`));
        reject(err);
      });
      
      // Send the command
      console.log(chalk.gray(`Sending command: "${command}"`));
      console.log(chalk.gray(`Command length: ${command.length} chars`));
      console.log(chalk.gray(`Command bytes: ${JSON.stringify(command.split(''))}`));
      stream.write(command + '\r\n');
      
      // Set timeout for safety
      setTimeout(() => {
        if (!isComplete) {
          console.log(chalk.yellow('Command timeout - forcing completion'));
          stream.end();
          if (fullResult.length > 0) {
            resolve(fullResult);
          } else {
            reject(new Error('Command timeout with no result'));
          }
        }
      }, 120000); // 2 minutes timeout
    });
  });
}

async function connectAndExecuteCommand(device, password, command, commandType) {
  const connection = new Telnet();
  
  try {
    console.log(chalk.yellow(`\nConnecting to ${device.ip} for ${commandType} command...`));
    
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
      debug: true
    };

    await connection.connect(params);
    console.log(chalk.green(`✓ Connected to ${device.ip}`));

    // Enter privileged mode if required
    if (device.requiresEnable && device.enableCommand) {
      console.log(chalk.gray(`Entering privileged mode...`));
      await connection.exec(device.enableCommand);
      console.log(chalk.green('✓ Entered privileged mode'));
    }

    // Execute the command
    const result = await executeCommand(connection, command, device);
    
    await connection.end();
    console.log(chalk.gray(`Connection closed for ${commandType} command`));
    
    return result;
    
  } catch (error) {
    console.log(chalk.red(`Error in ${commandType} command execution: ${error.message}`));
    try {
      await connection.end();
    } catch (e) {
      // Ignore connection close errors
    }
    throw error;
  }
}

async function testDLinkDataCollection() {
  try {
    // Device configuration for D-Link switch
    const device = {
      ip: "192.168.165.212",
      type: "switch",
      vendor: "D-Link",
      username: "admin",
      password: null,
      enableCommand: "enable", // D-Link может требовать enable
      requiresEnable: false, // ОТКЛЮЧЕНО для простого подключения
      paginationPrompts: [
        "q Quit SPACE n Next Page ENTER Next Entry a All",
        "CTRL+C ESC q Quit SPACE n Next Page ENTER Next Entry a All"
      ],
      paginationInput: "a", // D-Link ждет 'a' для показа всего
      commands: {
        config: [],
        mac: ["show fdb"]
      },
      description: "D-Link_Switch_212"
    };

    console.log(chalk.cyan(`\n=== Device Information ===`));
    console.log(chalk.white(`IP Address: ${device.ip}`));
    console.log(chalk.white(`Description: ${device.description}`));
    console.log(chalk.white(`Vendor: ${device.vendor} ${device.type.toUpperCase()}`));
    console.log(chalk.white(`Username: ${device.username}`));

    // Get password with multiple attempts
    let password = null;
    const maxPasswordAttempts = 3;
    
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
        ]);
        
        password = answers.password;
        
        // Quick test connection to validate password
        console.log(chalk.gray(`Testing connection with provided password...`));
        const testConnection = new Telnet();
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
        };
        
        await testConnection.connect(testParams);
        await testConnection.end();
        console.log(chalk.green(`✓ Password validated successfully`));
        break; // Password is correct, exit loop
        
      } catch (error) {
        console.log(chalk.red(`✗ Connection failed: ${error.message}`));
        
        if (attempt === maxPasswordAttempts) {
          throw new Error(`Failed to authenticate after ${maxPasswordAttempts} attempts`);
        } else {
          console.log(chalk.yellow(`Please try again...`));
        }
      }
    }

    console.log(chalk.cyan(`\n=== Starting data collection from ${device.ip} (${device.description}) ===`));

    // Test config commands with separate connection
    console.log(chalk.cyan('\n=== Collecting Configuration ==='));
    for (const command of device.commands.config) {
      try {
        const result = await connectAndExecuteCommand(device, password, command, 'CONFIG');

        if (result && result.trim().length > 0) {
          console.log(chalk.green(`✓ Command "${command}" successful`));
          console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`));

          // Save configuration
          const configDir = './configs';
          await fs.mkdir(configDir, { recursive: true });
          const filename = `${device.ip.replace(/\./g, '_')}.cfg`;
          const filepath = path.join(configDir, filename);
          
          // Check if file exists and log accordingly
          try {
            await fs.access(filepath);
            console.log(chalk.yellow(`Overwriting existing file: ${filepath}`));
          } catch {
            console.log(chalk.gray(`Creating new file: ${filepath}`));
          }
          
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

    // Test MAC commands with separate connection
    console.log(chalk.cyan('\n=== Collecting FDB Table ==='));
    for (const command of device.commands.mac) {
      try {
        const result = await connectAndExecuteCommand(device, password, command, 'FDB');

        if (result && result.trim().length > 0) {
          console.log(chalk.green(`✓ Command "${command}" successful`));
          console.log(chalk.gray(`Response preview: ${result.substring(0, 200)}...`));

          // Save FDB table
          const macDir = './mac_tables';
          await fs.mkdir(macDir, { recursive: true });
          const filename = `${device.ip.replace(/\./g, '_')}.mac`;
          const filepath = path.join(macDir, filename);
          
          // Check if file exists and log accordingly
          try {
            await fs.access(filepath);
            console.log(chalk.yellow(`Overwriting existing file: ${filepath}`));
          } catch {
            console.log(chalk.gray(`Creating new file: ${filepath}`));
          }
          
          await fs.writeFile(filepath, result, 'utf8');
          console.log(chalk.green(`FDB table saved: ${filepath}`));
          break; // Use first working command
        } else {
          console.log(chalk.red(`✗ Command "${command}" returned empty result`));
        }
      } catch (error) {
        console.log(chalk.red(`✗ Command "${command}" failed: ${error.message}`));
      }
    }

    console.log(chalk.green('\n✓ Data collection completed successfully'));

  } catch (error) {
    console.error(chalk.red(`\n✗ Test error: ${error.message}`));
  }
}

if (require.main === module) {
  console.log(chalk.cyan('=== D-Link Data Collection Test ===\n'));
  testDLinkDataCollection().catch(console.error);
}
