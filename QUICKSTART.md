# QUICK START

## Installation and First Run

1. **Dependencies already installed!** ✅

2. **Configure device list**
   Edit the `data/devices.json` file - add your IP addresses and commands

3. **Run the application**

   ```bash
   npm start
   ```

4. **Enter administrator password**
   The system will prompt for password at startup

5. **Choose action:**
   - Collect configurations
   - Collect MAC tables
   - Collect everything

## Results are saved in

- `configs/` - configurations (*.cfg files)
- `mac_tables/` - MAC tables (*.mac files)
- `logs/` - application logs

## Quick commands

```bash
npm run collect-configs    # configurations only
npm run collect-macs       # MAC tables only
npm run collect-all        # everything at once
npm run test-connection    # test connection to device
```

## Connection Testing

Before mass collection, test connection to one device:

```bash
npm run test-connection
```

## Device file structure (data/devices.json)

```json
[
  {
    "ip": "192.168.1.10",           // Device IP (required)
    "type": "switch",               // Type: switch, olt, router
    "vendor": "cisco",              // Manufacturer
    "username": "admin",            // Login (default admin)
    "password": null,               // Password (null = prompt)
    "commands": {
      "config": ["show running-config"],     // Config commands
      "mac": ["show mac address-table"]      // MAC commands
    },
    "description": "Core Switch 1"  // Device description
  }
]
```

## Command examples for different vendors

**Cisco:**

- Config: `show running-config`, `show startup-config`
- MAC: `show mac address-table`

**Huawei:**

- Config: `display current-configuration`
- MAC: `display mac-address`

**ZyXEL/BDCOM OLT:**

- Config: `show config effective`
- MAC: `show fdb`, `show mac address`

## What to do if device "hangs" on --More--

✅ System automatically handles pagination!

- Presses space to continue
- Handles various prompts
- Collects complete output

## Troubleshooting

1. **Cannot connect to device:**
   - Check availability: `ping IP`
   - Check Telnet: `telnet IP 23`
   - Ensure login/password are correct

2. **Incomplete data:**
   - Increase COMMAND_TIMEOUT in .env
   - Check logs in logs/collector.log

3. **Testing single device:**
   - Use `npm run test-connection`
