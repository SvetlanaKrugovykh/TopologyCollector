#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');

const devicesFile = './data/devices.json';

// Predefined commands for different vendors
const vendorCommands = {
  cisco: {
    config: ['show running-config'],
    mac: ['show mac address-table']
  },
  huawei: {
    config: ['display current-configuration'],
    mac: ['display mac-address']
  },
  zyxel: {
    config: ['show config effective'],
    mac: ['show fdb']
  },
  bdcom: {
    config: ['show config effective'],
    mac: ['show mac address']
  },
  juniper: {
    config: ['show configuration'],
    mac: ['show ethernet-switching table']
  },
  mikrotik: {
    config: ['/export'],
    mac: ['/interface bridge host print']
  },
  custom: {
    config: [''],
    mac: ['']
  }
};

async function loadDevices() {
  try {
    const data = await fs.readFile(devicesFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function saveDevices(devices) {
  await fs.writeFile(devicesFile, JSON.stringify(devices, null, 2), 'utf8');
}

async function addDevice() {
  console.log(chalk.cyan('=== Adding New Device ===\n'));

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'ip',
      message: 'Device IP address:',
      validate: (input) => {
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        if (!ipRegex.test(input)) {
          return 'Enter a valid IP address';
        }
        return true;
      }
    },
    {
      type: 'list',
      name: 'type',
      message: 'Device type:',
      choices: [
        { name: 'Switch', value: 'switch' },
        { name: 'OLT', value: 'olt' },
        { name: 'Router', value: 'router' },
        { name: 'Other', value: 'other' }
      ]
    },
    {
      type: 'list',
      name: 'vendor',
      message: 'Vendor:',
      choices: [
        { name: 'Cisco', value: 'cisco' },
        { name: 'Huawei', value: 'huawei' },
        { name: 'ZyXEL', value: 'zyxel' },
        { name: 'BDCOM', value: 'bdcom' },
        { name: 'Juniper', value: 'juniper' },
        { name: 'MikroTik', value: 'mikrotik' },
        { name: 'Other/Custom commands', value: 'custom' }
      ]
    },
    {
      type: 'input',
      name: 'username',
      message: 'Username:',
      default: 'admin'
    },
    {
      type: 'input',
      name: 'description',
      message: 'Device description:'
    }
  ]);

  // Get commands for selected vendor
  let commands = vendorCommands[answers.vendor] || vendorCommands.custom;

  // If custom selected or need to change commands
  if (answers.vendor === 'custom') {
    console.log(chalk.yellow('\nCommand setup:'));
    
    const configCommands = await inquirer.prompt([
      {
        type: 'input',
        name: 'config',
        message: 'Configuration command:',
        default: 'show running-config'
      }
    ]);

    const macCommands = await inquirer.prompt([
      {
        type: 'input',
        name: 'mac',
        message: 'MAC table command:',
        default: 'show mac address-table'
      }
    ]);

    commands = {
      config: [configCommands.config],
      mac: [macCommands.mac]
    };
  } else {
    // Show selected commands and offer to change them
    console.log(chalk.green(`\nSelected commands for ${answers.vendor}:`));
    console.log(chalk.gray(`Configuration: ${commands.config.join(', ')}`));
    console.log(chalk.gray(`MAC table: ${commands.mac.join(', ')}`));
    
    const changeCommands = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'change',
        message: 'Change commands?',
        default: false
      }
    ]);

    if (changeCommands.change) {
      const customCommands = await inquirer.prompt([
        {
          type: 'input',
          name: 'config',
          message: 'Configuration command:',
          default: commands.config[0]
        },
        {
          type: 'input',
          name: 'mac',
          message: 'MAC table command:',
          default: commands.mac[0]
        }
      ]);

      commands = {
        config: [customCommands.config],
        mac: [customCommands.mac]
      };
    }
  }

  const device = {
    ip: answers.ip,
    type: answers.type,
    vendor: answers.vendor,
    username: answers.username,
    password: null,
    commands: commands,
    description: answers.description
  };

  // Load existing devices
  const devices = await loadDevices();

  // Check if device with this IP already exists
  const existingDevice = devices.find(d => d.ip === device.ip);
  if (existingDevice) {
    const overwrite = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `Device with IP ${device.ip} already exists. Overwrite?`,
        default: false
      }
    ]);

    if (!overwrite.overwrite) {
      console.log(chalk.yellow('Operation cancelled.'));
      return;
    }

    // Remove old device
    const index = devices.findIndex(d => d.ip === device.ip);
    devices.splice(index, 1);
  }

  // Add new device
  devices.push(device);

  // Save
  await saveDevices(devices);

  console.log(chalk.green(`\n✓ Device ${device.ip} successfully added!`));
  console.log(chalk.gray(`Total devices in list: ${devices.length}`));
}

async function listDevices() {
  const devices = await loadDevices();
  
  if (devices.length === 0) {
    console.log(chalk.yellow('Device list is empty.'));
    return;
  }

  console.log(chalk.cyan('\n=== Device List ==='));
  devices.forEach((device, index) => {
    console.log(chalk.yellow(`${index + 1}. ${device.ip} - ${device.description}`));
    console.log(chalk.gray(`   Type: ${device.type}, Vendor: ${device.vendor}`));
    console.log(chalk.gray(`   Config: ${device.commands.config.join(', ')}`));
    console.log(chalk.gray(`   MAC: ${device.commands.mac.join(', ')}`));
    console.log('');
  });
}

async function removeDevice() {
  const devices = await loadDevices();
  
  if (devices.length === 0) {
    console.log(chalk.yellow('Device list is empty.'));
    return;
  }

  const choices = devices.map((device, index) => ({
    name: `${device.ip} - ${device.description}`,
    value: index
  }));

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'deviceIndex',
      message: 'Select device to remove:',
      choices: choices
    }
  ]);

  const device = devices[answer.deviceIndex];
  
  const confirm = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Remove device ${device.ip} - ${device.description}?`,
      default: false
    }
  ]);

  if (confirm.confirm) {
    devices.splice(answer.deviceIndex, 1);
    await saveDevices(devices);
    console.log(chalk.green(`✓ Device ${device.ip} removed!`));
  } else {
    console.log(chalk.yellow('Operation cancelled.'));
  }
}

async function main() {
  console.log(chalk.cyan('=== Device Management ===\n'));

  const action = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'Choose action:',
      choices: [
        { name: 'Add device', value: 'add' },
        { name: 'Show device list', value: 'list' },
        { name: 'Remove device', value: 'remove' },
        { name: 'Exit', value: 'exit' }
      ]
    }
  ]);

  switch (action.action) {
    case 'add':
      await addDevice();
      break;
    case 'list':
      await listDevices();
      break;
    case 'remove':
      await removeDevice();
      break;
    case 'exit':
      console.log(chalk.green('Exiting program.'));
      process.exit(0);
  }

  // Ask if need to continue
  const continueWork = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'continue',
      message: 'Continue working?',
      default: true
    }
  ]);

  if (continueWork.continue) {
    await main();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  });
}
