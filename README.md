## Batch Collection for All Device JSON Files

The script `run-all-json.js` allows you to automatically run the collection process for all device JSON files in the `data` directory (except `brandSettings.json`).

**Usage:**

```
node run-all-json.js
```

**How it works:**
- Iterates over all `.json` files in the `data` directory, except `brandSettings.json`.
- For each file, it runs the collection process as if it were the active devices file.
- If an error occurs for a file, the script logs the error and continues with the next file.
- At the end, all device files will have been processed, regardless of individual errors.

This is useful for batch processing or testing all device sets without changing environment variables or editing `.env`.
# Network Device Configuration Collector

System for automatic collection of configurations and MAC tables from network equipment (switches, OLTs) via Telnet.

## Features

- ✅ Configuration collection from various equipment types
- ✅ MAC table and FDB table collection
- ✅ Support for multiple commands per device
- ✅ Automatic pagination handling (--More--, Press any key, etc.)
- ✅ Save results in separate files by IP addresses
- ✅ Detailed operation logging
- ✅ Interactive and command-line management

## Project Structure

```
TopologyCollector/
├── data/
│   └── devices.json        # Device list for processing
├── configs/                # Saved configurations (*.cfg)
├── mac_tables/            # Saved MAC tables (*.mac)
├── logs/                  # Application logs
├── .env                   # Environment settings
├── package.json           # Node.js dependencies
└── index.js              # Main application
```

## Installation

1. Install Node.js (version 16 or higher)
2. Install dependencies:

```bash
npm install
```

## Device Configuration

Edit the `data/devices.json` file:

```json
[
  {
    "ip": "192.168.1.10",
    "type": "switch",
    "vendor": "cisco",
    "username": "admin",
    "password": null,
    "commands": {
      "config": ["show running-config"],
      "mac": ["show mac address-table"]
    },
    "description": "Core Switch 1"
  }
]
```

### Device Parameters:

- **ip** (required) - Device IP address
- **type** - Device type (switch, olt, router)
- **vendor** - Manufacturer (cisco, huawei, zyxel, bdcom, etc.)
- **username** - Username (default "admin")
- **password** - Password (if null, will be prompted at startup)
- **commands.config** - Commands for configuration retrieval
- **commands.mac** - Commands for MAC table retrieval
- **description** - Device description
- **appendMissingConfig** (optional) - For D-Link devices: attempt to collect remaining configuration data if initial command doesn't return complete config (default: false)

### Special D-Link Parameters

For D-Link switches that may not return complete configuration data in a single command execution, you can use the `appendMissingConfig` parameter:

```json
{
  "ip": "192.168.65.239",
  "type": "switch",
  "brand": "D-Link",
  "model": "DGS-3420-26SC",
  "appendMissingConfig": true,
  "commands": {
    "config": ["show config effective"],
    "mac": ["show fdb"]
  },
  "description": "D-Link Switch with config completion support"
}
```

**When to use `appendMissingConfig: true`:**
- D-Link devices that cut off configuration output mid-stream
- When you notice incomplete configuration files
- Configuration data appears in MAC table files instead

**How it works:**
1. Executes the main configuration command
2. If `appendMissingConfig: true`, runs the same command again to collect any remaining data
3. Appends the additional data to the configuration file
4. Cleans MAC table output from any configuration remnants
5. Ensures proper `logout` command timing

## Usage

### Interactive Mode
```bash
npm start
```

### Command Line
```bash
# Collect configurations only
npm run collect-configs

# Collect MAC tables only
npm run collect-macs

# Collect everything
npm run collect-all
```

### Direct Node.js Commands
```bash
node index.js --configs    # configurations
node index.js --macs       # MAC tables
node index.js --all        # everything
```

## Supported Vendors and Commands

### Cisco
- Configuration: `show running-config`, `show startup-config`
- MAC: `show mac address-table`

### Huawei
- Configuration: `display current-configuration`, `display saved-configuration`
- MAC: `display mac-address`

### ZyXEL (OLT)
- Configuration: `show config effective`
- MAC: `show fdb`

### BDCOM (OLT)
- Configuration: `show config effective`
- MAC: `show mac address`

## File Formats

### Configurations
Saved in `configs/` directory with filenames:
- `192_168_1_10.cfg`
- `10_0_0_1.cfg`

### MAC Tables
Saved in `mac_tables/` directory with filenames:
- `192_168_1_10.mac`
- `10_0_0_1.mac`

## Settings (.env)

```env
# Data storage directories
CONFIGS_DIR=./configs
MAC_TABLES_DIR=./mac_tables
LOGS_DIR=./logs

# Timeouts (milliseconds)
TELNET_TIMEOUT=30000
COMMAND_TIMEOUT=10000
LOGIN_TIMEOUT=5000

# Pause between commands
COMMAND_DELAY=2000

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/collector.log
```

## Operation Features

### Pagination Handling
The application automatically handles the following prompts:
- `--More--`
- `Press any key to continue`
- `Press SPACE to continue`
- `Press Enter to continue`
- `[Press 'A' for All or ENTER to continue]`
- `Type <CR> to continue`

### Security
- Passwords are not saved in configuration files
- Password prompt on each startup
- All connections via Telnet (recommended for isolated networks)

### Logging
- Detailed logs in `logs/collector.log` file
- Colored console output
- Various logging levels (debug, info, warn, error)

## Troubleshooting

### Connection Issues
1. Check device availability: `ping <ip>`
2. Check Telnet availability: `telnet <ip> 23`
3. Ensure correct login/password

### Incomplete Data
- Increase `COMMAND_TIMEOUT` in .env
- Check logs for pagination errors
- For D-Link devices: use `appendMissingConfig: true` if configuration appears incomplete
- Check if configuration data appears in MAC table files instead of config files

### D-Link Specific Issues
- **Incomplete configurations**: Add `"appendMissingConfig": true` to device configuration
- **Configuration data in MAC files**: The `appendMissingConfig` feature automatically cleans this up
- **Hanging connections**: The system uses proper logout timing and connection cleanup for D-Link devices

### Encoding Issues
- Ensure device uses UTF-8 or ASCII
- Add encoding handling in code if necessary

## Development Plans

- [ ] SSH connection support
- [ ] Task scheduler (cron)
- [ ] Web interface for management
- [ ] Configuration comparison between collections
- [ ] Export to various formats (JSON, CSV)
- [ ] Change notifications

## License

MIT License
