#!/usr/bin/env node

require('dotenv').config()
const { Telnet } = require('telnet-client')
const chalk = require('chalk')
const inquirer = require('inquirer')

async function testConnection() {
  try {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'ip',
        message: 'Enter device IP address for testing:',
        validate: (input) => {
          const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
          if (!ipRegex.test(input)) {
            return 'Enter a valid IP address'
          }
          return true
        }
      },
      {
        type: 'input',
        name: 'username',
        message: 'Enter username:',
        default: 'admin'
      },
      {
        type: 'password',
        name: 'password',
        message: 'Enter password:',
        mask: '*'
      }
    ])

    console.log(chalk.yellow(`\nConnecting to ${answers.ip}...`))

    const connection = new Telnet()
    const params = {
      host: answers.ip,
      port: 23,
      shellPrompt: /[$%#>]/,
      timeout: 15000,
      loginPrompt: /(username|login)[: ]*$/i,
      passwordPrompt: /password[: ]*$/i,
      username: answers.username,
      password: answers.password,
      execTimeout: 10000,
      debug: true
    }

    // Add source IP if specified in environment
    if (process.env.TELNET_SOURCE_IP) {
      params.localAddress = process.env.TELNET_SOURCE_IP
      console.log(chalk.blue(`Using source IP: ${process.env.TELNET_SOURCE_IP}`))
    }

    await connection.connect(params)
    console.log(chalk.green(`✓ Successful connection to ${answers.ip}`))

    // Test command
    console.log(chalk.yellow('\nExecuting test command...'))
    const result = await connection.exec('help')
    console.log(chalk.cyan('\nResult of "help" command:'))
    console.log(result.substring(0, 1000) + (result.length > 1000 ? '...' : ''))

    await connection.end()
    console.log(chalk.green('\n✓ Connection closed successfully'))

  } catch (error) {
    console.error(chalk.red(`\n✗ Connection error: ${error.message}`))

    if (error.message.includes('ECONNREFUSED')) {
      console.log(chalk.yellow('Possible causes:'))
      console.log('  - Telnet not enabled on device')
      console.log('  - Device unreachable')
      console.log('  - Firewall blocking connection')
    } else if (error.message.includes('timeout')) {
      console.log(chalk.yellow('Possible causes:'))
      console.log('  - Slow network')
      console.log('  - Incorrect credentials')
      console.log('  - Device overloaded')
    }
  }
}

if (require.main === module) {
  console.log(chalk.cyan('=== Device Connection Test ===\n'))
  testConnection().catch(console.error)
}
