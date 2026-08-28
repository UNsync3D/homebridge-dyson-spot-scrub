# homebridge-dyson-robot

A [Homebridge](https://homebridge.io) plugin for the **Dyson Spot+Scrub AI** robot vacuum/mop (RB05 series).

Exposes the robot to Apple HomeKit as four switches, a battery service, and a dock sensor — controllable from the Home app, Siri, and any HomeKit automation.

---

## HomeKit services

| Tile | What it does |
|---|---|
| **Vacuum** | Starts vacuum-only cleaning |
| **Vacuum and Mop** | Starts simultaneous vacuum + mop |
| **Mop** | Starts mop-only cleaning |
| **Vacuum then Mop** | Starts sequential vacuum-then-mop (vacuums first, then mops) |
| **Battery** | Shows charge level, low-battery alert, and charging state |
| **Dock** (contact sensor) | CLOSED = docked at base, OPEN = away |

Turning any switch **off** sends the robot back to its base.

---

## Requirements

- [Homebridge](https://homebridge.io) v1.3.5 or later
- Node.js 14.15.0 or later
- A Dyson account with the robot vacuum registered
- The robot and your Homebridge host on the same Wi-Fi network

---

## Installation

### Via Homebridge UI (recommended)

Search for `homebridge-dyson-robot` in the Homebridge plugin tab and click **Install**.

### Via npm

```bash
npm install -g homebridge-dyson-robot
```

---

## Setup

### 1. Authenticate with your Dyson account

Run the setup script once after installation. On a Raspberry Pi with Homebridge installed as a service:

```bash
sudo node /var/lib/homebridge/node_modules/homebridge-dyson-robot/scripts/auth.js
```

On macOS or a user-level install:

```bash
node $(npm root -g)/homebridge-dyson-robot/scripts/auth.js
```

The script will ask for your Dyson account **email**, **password**, and **country code** (e.g. `GB`, `US`, `AU`). It tries the legacy v1 login first (instant), then falls back to a one-time-password flow if needed — you'll receive a 6-digit code by email.

Your credentials are **not stored**. Only the resulting auth token is saved to your Homebridge storage directory (`/var/lib/homebridge/dyson-creds.json` on Linux, `~/.homebridge/dyson-creds.json` elsewhere).

### 2. Add the platform to `config.json`

```json
{
  "platforms": [
    {
      "platform": "DysonRobot",
      "name": "DysonRobot",
      "refreshIntervalSeconds": 30,
      "logMqtt": false
    }
  ]
}
```

| Key | Default | Description |
|---|---|---|
| `refreshIntervalSeconds` | `30` | How often to poll the robot for a state update |
| `logMqtt` | `false` | Set to `true` to log every MQTT state change to the Homebridge log |

### 3. Restart Homebridge

The plugin will discover your robot automatically, connect via MQTT, and add the HomeKit tiles.

---

## How it works

- **Authentication** uses the Dyson cloud API to obtain a per-device IoT certificate. This happens once at startup.
- **Control and state** then run entirely over local MQTT — no cloud round-trip for switching modes. The robot is addressed directly on your home network.
- State updates are pushed from the robot every 30 seconds (or immediately after a command). The plugin also listens for unsolicited state messages so the tiles update in real time when the robot finishes a clean or docks.

---

## Troubleshooting

**Tiles not appearing after install**
Run the auth script (step 1) and restart Homebridge. Check the log for lines beginning with `[DysonRobot]`.

**"No robot vacuums found"**
Make sure the robot is registered in your Dyson account and that the account email you used during auth matches.

**Tiles are unresponsive**
Make sure the robot and the Homebridge host are on the same Wi-Fi network. Check that no firewall is blocking MQTT (port 8883 on the robot's local IP).

**Log is noisy**
Set `"logMqtt": false` in your config (it defaults to `false`). If you need to debug, flip it to `true` temporarily.

---

## Supported models

Tested on the **Dyson Spot+Scrub AI** (product type `RB0S`). Other models in the RB05 family may work but have not been verified.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

Issues and PRs welcome at [github.com/UNsync3D/homebridge-dyson-robot](https://github.com/UNsync3D/homebridge-dyson-robot).
